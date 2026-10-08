// Real pipeline from the reply to persistence + real executor, entirely
// offline. No semantic judgment of the routine's condition is simulated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { createActionJournal, actionResult, renderCompletedActions } from './web/action-evidence.mjs';
import { routineFinalText, ROUTINE_NO_NEWS } from './web/routine-delivery.mjs';
import { createRoutineExecutor } from './web/routine-execution.mjs';
import { createInventoryCalculationSession } from './web/inventory-calculation.mjs';
import { turnSearchCoverage } from './web/turn-search-coverage.mjs';
import { createAppBuildJournal } from './web/app-build-state.mjs';
import { enforceRoutineEmailContract, enforceFreshCheckClaims } from './web/turn-claim-guard.mjs';
import { runAgent, ToolRegistry } from './core-proto/core.mjs';

const denied = () => { throw Error('External IO forbidden'); };
net.Socket.prototype.connect = tls.connect = globalThis.fetch = denied;
process.env.FONTES_LINKS = '0';
const source = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  const routineFinal = routineFinalText(') >= 0
  ? source.indexOf('  const routineFinal = routineFinalText(')
  : source.indexOf('  text = routineFinalText(');
const end = source.indexOf("  // The turn's images", start);
assert.ok(start > 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const savedMemory = {name:'memoria_anotar',args:{pagina:'monitoramento'},out:'Memória atualizada: monitoramento'};
const duplicateMemory = {...savedMemory,out:'Nada gravado (add:duplicado).'};
const writtenMemory = {name:'memoria_escrever',args:{slug:'monitoramento'},out:'Página "monitoramento" salva.'};
const updatedFact = {name:'memoria_atualizar',args:{pagina:'monitoramento',assunto:'synthetic_status'},out:'Memória atualizada: add(monitoramento) [synthetic_status]'};
const unchangedFact = {...updatedFact,out:'Nada gravado (definir:igual).'};

async function pipeline(text, {kind = 'routine', completed = true, failed = false,
  receipts = [savedMemory], partial = false, pending = null, termination = 'completed',
  language = 'pt-BR', emailStatus = null, actionJournal = null, appJournal = createAppBuildJournal()} = {}) {
  const journal = actionJournal || createActionJournal({language});
  for (const {name, args = {}, out} of receipts) journal.toolResult({name,args}, out);
  const before = journal.entries;
  const searchCoverage = turnSearchCoverage();
  if (partial) searchCoverage.observe(true);
  if (emailStatus) {
    searchCoverage.observeEmail([{provider:'gmail',account:'fixture@example.invalid',id:'synthetic-read',
      link:'https://mail.google.com/mail/#all/synthetic-read',subject:'Synthetic source',from:'fixture@example.invalid',read:true}]);
    searchCoverage.observeEmailCoverage([{account:'fixture@example.invalid',tool:'gmail_search',status:emailStatus,
      ...(emailStatus === 'partial' ? {reason:'more_pages'} : emailStatus === 'failed' ? {reason:'query_failed'} : {})}]);
  }
  const messages = [{role:'assistant',content:text}];
  const deps = {
    text,messages,kind,routineCheck:{completed,failed},userLang:language,idiomaResposta:language,
    inventoryCalculation:createInventoryCalculationSession({enabled:false,language}),
    routineFinalText,ROUTINE_NO_NEWS,curationResult:null,searchCoverage,
    actionJournal:journal,termination,confirmationSession:null,
    peekPending:() => pending,thread:{id:'routine-thread'},appBuildJournal:appJournal,
    enforceRoutineEmailContract,enforceFreshCheckClaims,renderCompletedActions,
    proposalPresentation:denied,selo:false,
    toolCounts:Object.fromEntries(receipts.map(row => [row.name,1])),savedUserMsg:'Avise apenas se houver queda',
    fontesEConferencia:denied,
  };
  const finish = new AsyncFunction(...Object.keys(deps), `const diag={removidas:[],corte(){}};\n${source.slice(start, end)}\nreturn {text,messages};`);
  const result = await finish(...Object.values(deps));
  assert.deepEqual(journal.entries, before, 'suppressing presentation does not erase evidence or metrics');
  assert.equal(result.messages.at(-1).content, result.text, 'return value and history must match');
  return {...result,entries:journal.entries,coverageWarnings:searchCoverage.emailWarnings(language)};
}

test('financial identifier and confirmation question pass through chat untouched', async () => {
  // No focus filter (2026-09-29): nothing in the pipeline cuts the offer or the requested data.
  for (const text of ['Resultado da consulta.', 'Chave PIX: synthetic-private-id',
    'Rascunhei o e-mail pro João.\n\nQuer que eu envie agora?']) {
    assert.equal((await pipeline(text, {kind:'chat', receipts:[]})).text, text);
  }
});

test('exact validated signal preserves silence with saved/duplicate memory in all three languages', async () => {
  for (const language of ['pt-BR','en','es']) {
    for (const receipts of [[], [savedMemory], [duplicateMemory], [writtenMemory], [savedMemory,duplicateMemory]]) {
      const result = await pipeline(ROUTINE_NO_NEWS, {language,receipts});
      assert.equal(result.text, '');
      assert.equal(result.entries.length, receipts.length);
    }
  }
});

test('real core completes check and memory with termination completed and pipeline preserves silence', async () => {
  const journal = createActionJournal(), routineCheck = {completed:false,failed:false}, toolCounts = {};
  const eventStart = source.indexOf("      if (ev?.type === 'tool_result') {", source.indexOf('  const interjecoes = [];'));
  const eventEnd = source.indexOf('      // Message the user sent mid-turn', eventStart);
  assert.ok(eventStart > 0 && eventEnd > eventStart);
  const onEvent = new Function('ev', 'routineCheck', 'toolCounts', source.slice(eventStart,eventEnd));
  const tools = new ToolRegistry()
    .add({name:'gmail_read',parameters:{type:'object',properties:{}},run:async () => ({ok:true,body:'Preço permanece igual.'})})
    .add({name:'memoria_anotar',parameters:{type:'object',properties:{}},run:async () => savedMemory.out});
  let step = 0;
  const result = await runAgent({
    provider:{name:'synthetic',complete:async () => ++step <= 2
      ? {stop:'tool',toolCalls:[{id:`call-${step}`,name:step === 1 ? 'gmail_read' : 'memoria_anotar',args:{}}]}
      : {stop:'end',text:ROUTINE_NO_NEWS}},
    tools,system:'Synthetic routine',history:[],userInput:'Avise somente se o preço cair.',
    transformToolResult:(call, out) => journal.toolResult(call, out),
    onEvent:ev => onEvent(ev, routineCheck, toolCounts),
  });
  assert.equal(result.termination, 'completed');
  assert.deepEqual(routineCheck, {completed:true,failed:false});
  const final = await pipeline(result.text, {...routineCheck,termination:result.termination,
    emailStatus:'complete',receipts:[],actionJournal:journal});
  assert.equal(final.text, '');
  assert.equal(final.entries.length, 1);
});

test('validated silence reaches the executor as no_output and delivery not_attempted', async () => {
  let persisted, deliveries = 0;
  const executor = createRoutineExecutor({
    claim:async () => true,phase:async () => true,
    finish:async (_routine, _token, status, outcome) => { persisted = {status,...outcome};return true; },
  });
  const result = await executor.execute({id:'synthetic-routine'}, {
    slot:'synthetic-slot',run:async () => (await pipeline(ROUTINE_NO_NEWS, {emailStatus:'complete'})).text,
    deliver:async () => { deliveries++;return {status:'accepted',channel:'telegram'}; },
  });
  assert.equal(deliveries, 0);
  assert.equal(result.status, 'no_output');
  assert.deepEqual(persisted, {status:'no_output',content:{status:'no_output'},delivery:{status:'not_attempted'}});
});

test('complete check sources do not revive validated silence, but remain in chat and findings', async () => {
  for (const language of ['pt-BR','en','es']) {
    assert.equal((await pipeline(ROUTINE_NO_NEWS, {emailStatus:'complete',language})).text, '');
  }
  for (const [text, kind] of [[ROUTINE_NO_NEWS,'chat'], ['Preço caiu para R$ 100.','routine'], ['', 'routine']]) {
    const result = await pipeline(text, {kind,emailStatus:'complete'});
    assert.match(result.text, /E-mails consultados/);
    assert.match(result.text, /Informação salva na memória permanente/);
  }
});

test('partial or failed check sources keep warning and receipts with the exact protocol', async () => {
  for (const emailStatus of ['partial','failed']) {
    const result = await pipeline(ROUTINE_NO_NEWS, {emailStatus});
    assert.ok(result.coverageWarnings.length > 0);
    assert.ok(result.coverageWarnings.every(warning => result.text.includes(warning)));
    assert.match(result.text, /E-mails consultados/);
    assert.match(result.text, /Informação salva na memória permanente/);
  }
});

test('chat, empty text without protocol and mixed signals keep showing receipts', async () => {
  for (const [text, kind] of [[ROUTINE_NO_NEWS,'chat'], ['', 'routine'], ['Sem novidades.', 'routine'],
    [`Resultado: ${ROUTINE_NO_NEWS}`, 'routine'], [`${ROUTINE_NO_NEWS}\nAnotado.`, 'routine']]) {
    const result = await pipeline(text, {kind});
    assert.match(result.text, /Informação salva na memória permanente/);
    assert.doesNotMatch(result.text, /dado financeiro/);
  }
});

test('missing or failed check does not become silence despite the protocol and saved memory', async () => {
  for (const state of [{completed:false,failed:false}, {completed:true,failed:true}, {completed:false,failed:true}]) {
    const result = await pipeline(ROUTINE_NO_NEWS, state);
    assert.match(result.text, /Não pude confirmar que não há novidades/);
    assert.match(result.text, /Informação salva na memória permanente/);
    assert.doesNotMatch(result.text, /dado financeiro/);
  }
});

test('check failure reaches the executor as a warning and attempts delivery', async () => {
  let deliveries = 0;
  const executor = createRoutineExecutor({claim:async () => true,phase:async () => true,finish:async () => true});
  await executor.execute({id:'failed-check-routine'}, {
    slot:'failed-check-slot',run:async () => (await pipeline(ROUTINE_NO_NEWS, {failed:true})).text,
    deliver:async (_routine, text) => {
      deliveries++;
      assert.match(text, /Não pude confirmar que não há novidades/);
      return {status:'accepted'};
    },
  });
  assert.equal(deliveries, 1);
});

test('partial search stays visible in the pipeline and is delivered by the executor', async () => {
  let deliveries = 0;
  const coverage = turnSearchCoverage();coverage.observe(true);
  const warning = coverage.finish('', 'pt-BR');
  const result = await pipeline(ROUTINE_NO_NEWS, {partial:true});
  assert.ok(warning.length > 0 && result.text.includes(warning));
  assert.match(result.text, /Informação salva na memória permanente/);
  assert.doesNotMatch(result.text, /dado financeiro/);
  const executor = createRoutineExecutor({claim:async () => true,phase:async () => true,finish:async () => true});
  await executor.execute({id:'partial-routine'}, {
    slot:'partial-slot',run:async () => result.text,
    deliver:async (_routine, text) => { deliveries++;assert.ok(text.includes(warning));return {status:'accepted'}; },
  });
  assert.equal(deliveries, 1);
});

test('other receipts, errors and pending items prevent suppression', async () => {
  const cases = [
    [{name:'memoria_anotar',out:{ok:false}}, /não foi concluída/],
    [{name:'memoria_anotar',out:'Resultado desconhecido'}, /Não consegui confirmar/],
    [{name:'criar_lista',out:{ok:true,lista:{id:'synthetic-list',versao:1,nome:'Compras'}}}, /Lista "Compras" salva/],
    [{name:'enviar_mensagem',out:actionResult({state:'accepted',id:'synthetic-send',target:'Telegram'}, 'aceito')}, /Envio aceito/],
    [{name:'gmail_send',out:'AÇÃO PENDENTE DE CONFIRMAÇÃO',args:{to:'synthetic@example.invalid'}}, /aguarda sua confirmação/],
    [{name:'criar_lembrete',out:actionResult({state:'scheduled',id:'synthetic-reminder',target:'Telegram'}, 'agendado')}, /Lembrete agendado/],
  ];
  for (const [receipt, expected] of cases) {
    for (const receipts of [[receipt], [savedMemory,receipt]]) {
      assert.match((await pipeline(ROUTINE_NO_NEWS, {receipts})).text, expected);
    }
  }
});

test('real confirmation card stays present after memory receipts are suppressed', async () => {
  const pending = {confirmationText:'Criar o evento sintético às 13h.\n\nPosso seguir?'};
  const result = await pipeline(ROUTINE_NO_NEWS, {pending});
  assert.ok(result.text.endsWith(pending.confirmationText));
  assert.match(result.text, /Informação salva na memória permanente/);
});

test('app journal failure stays visible after validated silence', async () => {
  const appJournal = createAppBuildJournal({failedPublication:true,publicationError:'Falha sintética de publicação.'});
  const result = await pipeline(ROUTINE_NO_NEWS, {appJournal});
  assert.equal(result.text, 'Falha sintética de publicação.');
});

test('suppression option does not hide useful text, explicit warning or termination', () => {
  const journal = createActionJournal();
  journal.toolResult(savedMemory, savedMemory.out);
  for (const text of ['Preço caiu para R$ 100.', 'Falha: acesso negado.', '⚠️ Busca parcial: erro na consulta.']) {
    const result = journal.finish(text, {suppressRoutineMemoryReceipts:true});
    assert.ok(result.includes(text));
    assert.match(result, /Informação salva na memória permanente/);
  }
  assert.match(journal.finish('', {termination:'provider_failure',suppressRoutineMemoryReceipts:true}), /Informação salva na memória permanente/);
});

const LOCALE_EXPECTATIONS = [
  ['pt-BR', /Não pude confirmar que não há novidades/, /Informação salva na memória permanente/, /E-mails consultados/, /A resposta pode estar incompleta\./],
  ['en', /I could not confirm that there are no updates/, /Information saved to permanent memory/, /Emails consulted/, /The answer may be incomplete\./],
  ['es', /No pude confirmar que no haya novedades/, /Información guardada en la memoria permanente/, /Correos consultados/, /La respuesta puede estar incompleta\./],
];
for (const [language, checkWarning, memoryReceipt, sourceTitle, partialWarning] of LOCALE_EXPECTATIONS) {
  test(`check warnings respect ${language} in the pipeline and financial identifier passes through intact`, async () => {
    const identifier = 'PIX: 00000000-0000-4000-8000-000000000000';
    assert.equal((await pipeline(identifier, {language, receipts:[]})).text, identifier);
    for (const state of [{completed:false}, {failed:true}]) {
      const result = await pipeline(ROUTINE_NO_NEWS, {language, ...state});
      assert.match(result.text, checkWarning);
      assert.match(result.text, memoryReceipt);
    }
    for (const emailStatus of ['partial','failed']) {
      const result = await pipeline(ROUTINE_NO_NEWS, {language, emailStatus});
      assert.match(result.text, partialWarning);
      assert.match(result.text, memoryReceipt);
      assert.match(result.text, sourceTitle);
      assert.ok(result.coverageWarnings.every(warning => result.text.includes(warning)));
    }
    const result = await pipeline(ROUTINE_NO_NEWS, {language, partial:true});
    const coverage = turnSearchCoverage(); coverage.observe(true);
    const warning = coverage.finish('', language);
    assert.ok(result.text.includes(warning));
    assert.match(result.text, memoryReceipt);
  });
}

for (const [language, checkWarning, memoryReceipt, sourceTitle, partialWarning] of LOCALE_EXPECTATIONS) {
  test(`memory v2 saved/unchanged preserves silence and evidence in ${language}`, async () => {
    for (const [receipt,state] of [[updatedFact,'saved'],[unchangedFact,'already_saved']]) {
      const result = await pipeline(ROUTINE_NO_NEWS,{language,emailStatus:'complete',receipts:[savedMemory,receipt]});
      assert.equal(result.text,'');
      assert.equal(result.entries.length,2);
      assert.equal(result.entries[1].tool,'memoria_atualizar');
      assert.equal(result.entries[1].state,state);
      let delivered=0,persisted;
      const executor=createRoutineExecutor({claim:async()=>true,phase:async()=>true,
        finish:async(_r,_t,status,outcome)=>{persisted={status,...outcome};return true;}});
      await executor.execute({id:'synthetic-memory-v2-routine'},{slot:'synthetic-slot',
        run:async()=>result.text,deliver:async()=>{delivered++;return {status:'accepted'};}});
      assert.equal(delivered,0);
      assert.deepEqual(persisted,{status:'no_output',content:{status:'no_output'},delivery:{status:'not_attempted'}});
    }
  });
  test(`memory v2 does not hide chat, failures, partial coverage or other effects in ${language}`, async () => {
    for (const receipts of [[updatedFact],[unchangedFact]]) {
      assert.ok((await pipeline(ROUTINE_NO_NEWS,{language,receipts,kind:'chat'})).text.trim());
      assert.ok((await pipeline('',{language,receipts})).text.trim());
      assert.ok((await pipeline(ROUTINE_NO_NEWS,{language,receipts,termination:'provider_failure'})).text.trim());
      for (const state of [{completed:false},{failed:true}]) {
        assert.match((await pipeline(ROUTINE_NO_NEWS,{language,receipts,...state})).text,checkWarning);
      }
      for (const emailStatus of ['partial','failed']) {
        const result=await pipeline(ROUTINE_NO_NEWS,{language,receipts,emailStatus});
        assert.match(result.text,partialWarning);assert.match(result.text,sourceTitle);
        assert.ok(result.coverageWarnings.every(warning=>result.text.includes(warning)));
      }
    }
    for (const out of [{ok:false},'Synthetic unknown result']) {
      const result=await pipeline(ROUTINE_NO_NEWS,{language,receipts:[{...updatedFact,out}]});
      assert.ok(['failed','unknown'].includes(result.entries[0].state));
      assert.ok(result.text.trim());assert.doesNotMatch(result.text,memoryReceipt);
    }
    const otherEffect={name:'criar_lista',out:{ok:true,lista:{id:'synthetic-v2-list',versao:1,nome:'Synthetic list'}}};
    const result=await pipeline(ROUTINE_NO_NEWS,{language,receipts:[updatedFact,otherEffect]});
    assert.match(result.text,/Synthetic list/);assert.match(result.text,memoryReceipt);
  });
}
