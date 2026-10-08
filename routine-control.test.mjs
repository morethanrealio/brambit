// Real server boundary and real routine SQL in an isolated local DB.
// A model turn simulates the lock via reservation; controls don't reach it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
const denied = () => { throw Error('External IO forbidden'); };
net.Socket.prototype.connect = tls.connect = globalThis.fetch = denied;
registerHooks({resolve(specifier, context, next) {
  if (specifier === './compras.mjs' && context.parentURL?.endsWith('/web/confirm.mjs')) {
    return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  }
  return next(specifier, context);
}});
const {confirmationFixture} = await import('./test-support/confirmation-fixture.mjs');
const sessions = await import('./web/confirmation-session.mjs');
const flow = await import('./web/confirmation-flow.mjs');
const {withConfirmationReceipt} = await import('./web/channel-confirmation.mjs');
const {gateTool, CHANNEL_CTX_END} = await import('./web/confirm.mjs');
const {codingPolicySnapshot, codingControlIntent} = await import('./web/coding-jobs.mjs');
const {migrateCodingConfirmation} = await import('./web/confirmation-recovery.mjs');
const {handleRoutinePause,routinePauseIntent} = await import('./web/routine-control.mjs');
const {routineConfirmationSnapshot} = await import('./web/confirmation-bindings.mjs');
const {createRoutineExecutionStore} = await import('./web/routine-execution.mjs');
const {prepareCurationChange} = await import('./web/curation-config.mjs');
const {prepareEmailSearchChange} = await import('./web/email-search-config.mjs');
const source = readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
const dbSource = readFileSync(new URL('./web/db.mjs',import.meta.url),'utf8');
const start = source.indexOf('async function runConversationInThread(');
const end = source.indexOf('// Cooldown for the no-credit emergency turn',start);
const extract = name => {
  const a = dbSource.indexOf(`export async function ${name}(`), b = dbSource.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a);
  return dbSource.slice(a + 'export '.length,b + 2);
};
const extractSync = (name, deps = {}) => {
  const marker = `function ${name}(`, a = dbSource.indexOf(marker), b = dbSource.indexOf('\n}\n',a);
  assert.ok(a > 0 && b > a);
  return new Function(...Object.keys(deps),`${dbSource.slice(a,b + 2)}; return ${name};`)(...Object.values(deps));
};
const composeRoutineConfig = extractSync('composeRoutineConfig',{prepareCurationChange,prepareEmailSearchChange});
const emailSearchTipo = extractSync('emailSearchTipo');

async function fixture(t, language = 'pt-BR') {
  const f = await confirmationFixture();t.after(() => f.db.close());
  await f.db.exec(`ALTER TABLE mtr_harness.agents ADD COLUMN name text;
    CREATE TABLE mtr_harness.routines(id uuid PRIMARY KEY,user_id uuid,agent_id uuid,title text,prompt text,
      hour integer DEFAULT 8,minute integer NOT NULL DEFAULT 0,days text DEFAULT 'daily',tz text DEFAULT 'UTC',channel text DEFAULT 'telegram',
      enabled boolean DEFAULT true,last_run_day text,repeat_every_min integer,repeat_until timestamptz,next_run timestamptz,
      config jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());`);
  const state = {agent:{id:f.scope.agentId,category:'pessoal'},thread:{id:f.scope.threadId,agent_id:f.scope.agentId,history:[]},
    modelTurns:0, updates:[], beforeUpdate:null, persistedAtReceipt:[], credit:{over:true}};
  const list = new Function('pool','S', `${extract('listRoutinesForUser')}; return listRoutinesForUser;`)(f.pool,'mtr_harness');
  const rawUpdate = new Function('pool','S','composeRoutineConfig','emailSearchTipo', `${extract('updateRoutine')}; return updateRoutine;`)(f.pool,'mtr_harness',composeRoutineConfig,emailSearchTipo);
  const update = async (...args) => {
    state.updates.push(structuredClone(args));
    if (state.beforeUpdate) await state.beforeUpdate(...args);
    return rawUpdate(...args);
  };
  const deps = {...sessions,...flow,withConfirmationReceipt,codingPolicySnapshot,codingControlIntent,jevEnabled:()=>false,jevCodingControl:async()=>null,migrateCodingConfirmation,
    handleRoutinePause,routinePauseIntent,getCreditStatus:async () => state.credit,listRoutinesForUser:list,updateRoutine:update,
    confirmationStore:f.store,confirmationRecovery:{continueCoding:async () => {}},
    withThreadLock:async (_id, run) => run(),getUserLocale:async () => ({language}),
    getThreadOwned:async () => structuredClone(state.thread),getAgentOwned:async () => state.agent,
    saveThreadTurn:async (_id, _agent, data) => {
      state.persistedAtReceipt = await list(f.scope.userId);
      state.thread.history = data.history;
    },
    createCodingApprovals:() => ({peek:async () => null}),appTaskStore:{},codingJobs:{status:async () => ({})},
    runConversationTurn:async () => { state.modelTurns++;return {text:'Synthetic reservation blocked',attachments:[]}; },
  };
  const run = new Function(...Object.keys(deps),source.slice(start,end)+'\nreturn runConversationInThread;')(...Object.values(deps));
  async function add(title, {id = randomUUID(), agentId = f.scope.agentId, userId = f.scope.userId, enabled = true} = {}) {
    await f.db.query('INSERT INTO mtr_harness.agents(id,user_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[agentId,userId,'Synthetic assistant']);
    await f.db.query('INSERT INTO mtr_harness.routines(id,user_id,agent_id,title,prompt,enabled) VALUES($1,$2,$3,$4,$5,$6)',[id,userId,agentId,title,'Synthetic private prompt',enabled]);
    return id;
  }
  const row = async id => (await f.db.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[id])).rows[0];
  const turn = (message, opts = {}) => run(state.agent,state.thread,f.scope.userId,message,{kind:'chat',...opts});
  return {...f,state,add,row,turn,rawUpdate};
}

for (const [language,message,choose,command,paused] of [
  ['pt-BR','oi bom dia, pode encerrar os monitoramentos',/Qual rotina você quer pausar/, 'Pause a rotina "Preço diário"', /pausada/],
  ['en','Hi, can you stop the monitors',/Which routine do you want to pause/, 'Pause the routine "Preço diário"', /paused/],
  ['es','Hola, ¿puedes detener los monitoreos?',/¿Qué rutina quieres pausar/, '¿Puedes pausar la rutina "Preço diário"?', /pausada/],
]) test(`${language}: pedido genérico identifica opções e seleção explícita pausa antes do modelo/crédito`, async t => {
  const f = await fixture(t,language);
  const first = await f.add('Preço diário'), second = await f.add('Resumo semanal');
  const before = await f.row(first);
  const options = await f.turn(message);
  assert.match(options.text, choose);
  assert.match(options.text, /Preço diário/);
  assert.match(options.text, /Resumo semanal/);
  assert.deepEqual(f.state.updates, []);
  assert.equal(f.state.modelTurns, 0);
  const result = await f.turn(command);
  assert.match(result.text, paused);
  assert.match(result.text, /Preço diário/);
  assert.equal(f.state.modelTurns, 0);
  assert.deepEqual(await f.row(first), {...before,enabled:false});
  assert.equal(f.state.persistedAtReceipt.find(row => row.id === first).enabled,false);
  assert.equal((await f.row(second)).enabled,true);
  assert.equal(f.state.thread.history.at(-1).content,result.text);
  assert.deepEqual(Object.keys(f.state.updates[0][2]).sort(), ['enabled','expected']);
  assert.equal(f.state.updates[0][2].expected.agent_id,f.scope.agentId);
});

test('títulos iguais, códigos ambíguos e rotina de outro dono não autorizam pausa', async t => {
  const f = await fixture(t);
  const a = await f.add('Mesmo título',{id:'abcd0000-0000-4000-8000-000000000001'});
  const b = await f.add('Mesmo título',{id:'abcd1100-0000-4000-8000-000000000002'});
  const other = await f.add('Outro agente',{agentId:randomUUID()});
  const foreign = await f.add('Outro dono',{userId:randomUUID()});
  for (const message of ['Pause a rotina Mesmo título','Pause a rotina #abcd','Pause a rotina Outro dono']) {
    const result = await f.turn(message);
    assert.match(result.text,/Qual rotina você quer pausar/);
    assert.doesNotMatch(result.text,/Outro dono|Synthetic private prompt/);
  }
  assert.deepEqual(f.state.updates,[]);assert.equal(f.state.modelTurns,0);
  const listing = await f.turn('Pause as rotinas');
  assert.match(listing.text,/#abcd00/);assert.match(listing.text,/#abcd11/);
  await f.turn('Pause a rotina #abcd00');
  assert.equal((await f.row(a)).enabled,false);
  for (const id of [b,other,foreign]) assert.equal((await f.row(id)).enabled,true);
  // Mesmo dono, outro assistente: igual a listar_rotinas/editar_rotina, o dono pode pausar.
  assert.match((await f.turn('Pause a rotina Outro agente')).text,/pausada/);
  assert.equal((await f.row(other)).enabled,false);
  assert.equal((await f.row(foreign)).enabled,true);
});

test('frustração 25/09: "cancelar o monitoramento programado, todos" pausa os monitoramentos do dono sem turno de modelo', async t => {
  const f = await fixture(t);const travor = randomUUID();
  const tarde = await f.add('Monitoramento Passagens Orlando 2027 - Tarde',{agentId:travor});
  const manha = await f.add('Monitoramento Passagens Orlando 2027 - Manhã',{agentId:travor});
  const resumo = await f.add('Resumo semanal',{agentId:travor});
  const foreign = await f.add('Monitoramento alheio',{userId:randomUUID()});
  const result = await f.turn('pode cancelar o monitoramento programado, todos, por favor');
  assert.match(result.text,/Pausei estas rotinas/);
  assert.match(result.text,/Orlando 2027 - Tarde/);assert.match(result.text,/Orlando 2027 - Manhã/);
  assert.doesNotMatch(result.text,/Resumo semanal|alheio/);
  for (const id of [tarde,manha]) assert.equal((await f.row(id)).enabled,false);
  for (const id of [resumo,foreign]) assert.equal((await f.row(id)).enabled,true);
  assert.ok(f.state.updates.every(u => u[2].expected.agent_id === travor));
  assert.equal(f.state.modelTurns,0,'não passa pela reserva de crédito');
  assert.match((await f.turn('Cancele todas as rotinas')).text,/Resumo semanal/);
  assert.equal((await f.row(resumo)).enabled,false);
  assert.equal(f.state.modelTurns,0);
});

test('com proposta pendente, "cancela a rotina" continua sendo recusa da proposta', async t => {
  const f = await fixture(t);const id = await f.add('Diaria');
  const session = await sessions.createConfirmationSession(f.store,f.scope);
  await sessions.withConfirmationSession(session, () => gateTool({name:'calendar_create',run:denied},f.scope.threadId).run({title:'Evento',start:'2026-09-25T13:00:00',end:'2026-09-25T13:30:00'}));
  await f.store.present(f.scope,session.pending().map(row => row.id));
  f.state.thread.history = [{role:'assistant',content:flow.proposalPresentation(session.pending())}];
  await f.turn('cancela todas as rotinas');
  assert.equal((await f.row(id)).enabled,true);assert.deepEqual(f.state.updates,[]);
});

test('falta de rotinas e pausa repetida têm respostas reais sem chamada de modelo', async t => {
  const f = await fixture(t,'en');
  assert.match((await f.turn('Stop the monitors')).text,/no routines to pause/i);
  const id = await f.add('Daily report',{enabled:false});
  const before = await f.row(id);
  assert.match((await f.turn('Pause the routine Daily report')).text,/already paused/);
  assert.deepEqual(await f.row(id),before);
  assert.equal(f.state.modelTurns,0);
});

test('mudança concorrente de título, intervalo ou assistente impede a pausa e o falso recibo', async t => {
  const f = await fixture(t);
  for (const field of ['title','repeat_every_min','agent_id']) {
    const id = await f.add('Teste '+field);
    f.state.beforeUpdate = async () => {
      const value = field === 'title' ? 'Novo título' : field === 'repeat_every_min' ? 60 : randomUUID();
      await f.db.query(`UPDATE mtr_harness.routines SET ${field}=$2 WHERE id=$1`,[id,value]);
    };
    const result = await f.turn(`Pause a rotina Teste ${field}`);
    assert.match(result.text,/Não consegui confirmar a pausa/);
    assert.equal((await f.row(id)).enabled,true);
  }
  assert.equal(f.state.modelTurns,0);
});

test('falha no armazenamento não produz afirmação de pausa', async t => {
  const f = await fixture(t,'es');const id = await f.add('Diaria');
  f.state.beforeUpdate = async () => { throw Error('Synthetic storage failure'); };
  const result = await f.turn('Pausa la rutina Diaria');
  assert.match(result.text,/No pude confirmar la pausa/);
  assert.doesNotMatch(result.text,/Synthetic storage failure/);
  assert.equal((await f.row(id)).enabled,true);
});

test('pausa preserva configurações tipadas e heartbeat concorrente sem prometer interrupção em curso', async t => {
  const f = await fixture(t,'en');
  for (const config of [{curation:{source:'gmail'}},{email_search:{provider:'gmail'}},{flight_monitor:{version:1}}]) {
    const id = await f.add('Synthetic routine');
    await f.db.query('UPDATE mtr_harness.routines SET config=$2, repeat_every_min=30, repeat_until=$3 WHERE id=$1',
      [id,JSON.stringify(config),'2026-10-30T20:00:00Z']);
    f.state.beforeUpdate = async () => {
      await f.db.query("UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution}',$2) WHERE id=$1",
        [id,JSON.stringify({status:'running',token:'synthetic-heartbeat'})]);
    };
    const result = await f.turn(`Pause the routine #${id}`);
    assert.match(result.text,/paused/);
    assert.match(result.text,/already dispatched or in progress may still finish/);
    const saved = await f.row(id);
    assert.equal(saved.enabled,false);
    assert.equal(saved.repeat_every_min,30);
    assert.deepEqual(saved.config,{...config,execution:{status:'running',token:'synthetic-heartbeat'}});
  }
  assert.equal(f.state.modelTurns,0);
});

test('pausa retira rotina e extras pendentes da seleção futura sem apagar a fila ou alterar o intervalo', async t => {
  const f = await fixture(t);const id = await f.add('Intervalo');
  await f.db.exec(`ALTER TABLE mtr_harness.users ADD COLUMN email text, ADD COLUMN name text, ADD COLUMN language text;
    CREATE TABLE mtr_harness.routine_one_shots(id uuid PRIMARY KEY,routine_id uuid,user_id uuid,run_at timestamptz,status text);`);
  await f.db.query("UPDATE mtr_harness.routines SET repeat_every_min=30,next_run=now()-interval '1 minute' WHERE id=$1",[id]);
  await f.db.query("INSERT INTO mtr_harness.routine_one_shots VALUES ($1,$2,$3,now()-interval '1 minute','pending')",[randomUUID(),id,f.scope.userId]);
  const load = name => new Function('pool','S',`${extract(name)}; return ${name};`)(f.pool,'mtr_harness');
  const due = load('listDueRoutines'), extras = load('listDueRoutineOneShots');
  const before = await f.row(id);
  assert.equal((await due()).length,1);assert.equal((await extras()).length,1);
  const result = await f.turn('Pause a rotina Intervalo');
  assert.match(result.text,/já encaminhada ou em andamento/);
  assert.equal((await due()).length,0);assert.equal((await extras()).length,0);
  assert.deepEqual(await f.row(id),{...before,enabled:false});
  const execution = createRoutineExecutionStore(f.pool);
  assert.equal(await execution.claim(before,'interval:'+before.next_run.toISOString(),randomUUID()),false);
  assert.equal(await execution.claim(before,'day:2026-09-23',randomUUID()),false);
  assert.equal((await f.db.query('SELECT status FROM mtr_harness.routine_one_shots')).rows[0].status,'pending');
});

test('título com Markdown e quebra é exibido como texto e pode ser selecionado por código', async t => {
  const f = await fixture(t,'es');
  const title = '**Diaria**\n[Informe](https://example.invalid) `x`';
  const id = await f.add(title);
  const listing = await f.turn('Pausa las rutinas');
  assert.match(listing.text,/• `` \*\*Diaria\*\* \[Informe\]\(https:\/\/example.invalid\) `x` `` — activa/);
  assert.equal(listing.text.split('\n').length,3);
  const result = await f.turn(`Pausa la rutina #${id}`);
  assert.match(result.text,/Rutina `` \*\*Diaria\*\*/);
  assert.equal((await f.row(id)).title,title);
  assert.equal((await f.row(id)).enabled,false);
  assert.match(result.text,/ya enviada o en curso/);
});

test('condição, horário ou comando composto sem aspas não autoriza uma pausa por coincidência com título', async t => {
  const f = await fixture(t);
  for (const [title,message] of [
    ['Diaria depois do resumo','Pause a rotina Diaria depois do resumo'],
    ['Daily if there is no update','Pause the routine Daily if there is no update'],
    ['Diaria mañana','Pausa la rutina Diaria mañana'],
    ['Daily and restart','Stop the routine Daily and restart'],
  ]) {
    const id = await f.add(title);
    assert.match((await f.turn(message)).text,/Qual rotina você quer pausar/);
    assert.equal((await f.row(id)).enabled,true);
  }
  assert.deepEqual(f.state.updates,[]);
  assert.equal(f.state.modelTurns,0);
  // Quotes separate a literal title from conditional language.
  assert.match((await f.turn('Pause a rotina "Diaria depois do resumo"')).text,/pausada/);
});

test('recusa simples mantém precedência da proposta; citação não vira controle de rotina', async t => {
  const f = await fixture(t);const id = await f.add('Diaria');
  const session = await sessions.createConfirmationSession(f.store,f.scope);
  await sessions.withConfirmationSession(session, () => gateTool({name:'calendar_create',run:denied},f.scope.threadId).run({title:'Evento',start:'2026-09-25T13:00:00',end:'2026-09-25T13:30:00'}));
  await f.store.present(f.scope,session.pending().map(row => row.id));
  f.state.thread.history = [{role:'assistant',content:flow.proposalPresentation(session.pending())}];
  assert.match((await f.turn('não')).text,/Cancelei/);
  assert.equal((await f.store.list(f.scope))[0].state,'canceled');
  for (const [message,opts] of [
    ['Pause a rotina Diaria',{confirmationTarget:{channel:'whatsapp',messageId:'unrelated'}}],
    [`[Pause a rotina Diaria]${CHANNEL_CTX_END}Como funciona?`,{}],
    ['Pause a rotina Diaria',{viaReaction:true}],
    ['Pause a rotina Diaria pedido 1',{}],
    ['Pause the routine Diaria request 1',{}],
    ['Pausa la rutina Diaria solicitud 1',{}],
  ]) await f.turn(message,opts);
  assert.equal((await f.row(id)).enabled,true);
  assert.deepEqual(f.state.updates,[]);
});

test('pausa explícita de rotina não cancela nem aprova uma proposta pendente de mesmo título', async t => {
  const f = await fixture(t);const id = await f.add('Diaria');
  const session = await sessions.createConfirmationSession(f.store,f.scope);
  await sessions.withConfirmationSession(session, () => gateTool({name:'calendar_create',run:denied},f.scope.threadId).run({title:'Diaria',start:'2026-09-25T13:00:00',end:'2026-09-25T13:30:00'}));
  await f.store.present(f.scope,session.pending().map(row => row.id));
  f.state.thread.history = [{role:'assistant',content:flow.proposalPresentation(session.pending())}];
  assert.match((await f.turn('Pause a rotina Diaria')).text,/pausada/);
  assert.equal((await f.row(id)).enabled,false);
  assert.equal((await f.store.list(f.scope))[0].state,'pending');
  assert.equal(f.state.modelTurns,0);
});

test('rotina, webhook, grupo e pedido não imperativo não ganham acesso ao controle do dono', async t => {
  const f = await fixture(t);const id = await f.add('Diaria');
  for (const opts of [{kind:'routine'},{webhook:{}},{ephemeral:true},{noTools:true}]) await f.turn('Pause a rotina Diaria',opts);
  f.state.agent.category = 'grupo';await f.turn('Pause a rotina Diaria');f.state.agent.category = 'pessoal';
  for (const message of ['Não pause a rotina Diaria','Do not pause the routine Diaria','No pauses la rutina Diaria',
    'Ela disse: pause a rotina Diaria','How can I pause the routine Diaria?', '¿Cómo puedo pausar la rutina Diaria?',
    'Se eu pedir, pause a rotina Diaria','¿Si no hay novedades, puedes detener la rutina Diaria?',
    'Para a rotina Diaria','pause', 'pare', 'cancele']) await f.turn(message);
  assert.deepEqual(f.state.updates,[]);
  assert.equal((await f.row(id)).enabled,true);
});

test('expectativa de escopo da operação SQL não permite mover uma pausa para outro assistente', async t => {
  const f = await fixture(t);const id = await f.add('Diaria');const row = await f.row(id);
  await assert.rejects(f.rawUpdate(id,f.scope.userId,{enabled:false,expected:{...routineConfirmationSnapshot(row),agent_id:randomUUID()}}),{code:'ROUTINE_CHANGED'});
  assert.equal((await f.row(id)).enabled,true);
});

test('frustração 25/09, inglês e espanhol: "turn off", "scheduled" antes do nome e "apaga" só em espanhol', async t => {
  const en = await fixture(t,'en');
  const a = await en.add('Flight monitor Orlando');const b = await en.add('Weekly summary');
  assert.match((await en.turn('turn off all monitors')).text,/I paused these routines/);
  assert.equal((await en.row(a)).enabled,false);assert.equal((await en.row(b)).enabled,true);
  assert.match((await en.turn('please stop all scheduled routines')).text,/Weekly summary/);
  assert.equal((await en.row(b)).enabled,false);assert.equal(en.state.modelTurns,0);
  const es = await fixture(t,'es');
  const c = await es.add('Monitoreo vuelos Orlando');
  assert.match((await es.turn('apaga todos los monitoreos')).text,/Pausé estas rutinas/);
  assert.equal((await es.row(c)).enabled,false);assert.equal(es.state.modelTurns,0);
  // In Portuguese "apaga" means delete: it doesn't become a pause, it goes to the model.
  const pt = await fixture(t,'pt-BR');
  const d = await pt.add('Monitoramento Orlando');
  await pt.turn('apaga todos os monitoramentos');
  assert.equal((await pt.row(d)).enabled,true);assert.equal(pt.state.modelTurns,1);
});

test('com crédito, parar rotina é decisão do modelo: a regra fixa não pausa nada', async t => {
  // Eval 28/09 (#1): a regra pausava "rotina de treino A e B" e pedido condicional.
  const f = await fixture(t);
  f.state.credit = {over:false};
  const id = await f.add('Preço diário');
  for (const message of ['Pause a rotina "Preço diário"','Pode parar a rotina de treino A e B?']) {
    assert.equal((await f.turn(message)).text,'Synthetic reservation blocked');
  }
  assert.equal(f.state.modelTurns,2);assert.deepEqual(f.state.updates,[]);
  assert.equal((await f.row(id)).enabled,true);
});
