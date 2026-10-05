import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runGoogleReadAccounts, selectGoogleReadAccounts, googleReconnectError } from './web/google-read-scope.mjs';
import { googleTools } from './web/connectors.mjs';
import { trackEmailPagination } from './web/email-pagination.mjs';
import { turnSearchCoverage } from './web/turn-search-coverage.mjs';
import { runAgent, ToolRegistry } from './core-proto/core.mjs';
import { guardEmailCoverageClaims } from './web/email-search-coverage.mjs';
import { createEmailResearchSession } from './web/email-research-session.mjs';
import { EMAIL_RESEARCH_CONTRACT } from './web/email-answer-contract.mjs';

const personal='personal@example.invalid', work='work@example.invalid';
const accounts=[{google_email:personal},{google_email:work}];
const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function runGoogleSubagent('),end=source.indexOf('\n}\n',start)+2;
function worker(provider) {
  const deps={ToolRegistry,runAgent,makeSubagentProvider:()=>provider,trackEmailPagination,createEmailResearchSession,EMAIL_RESEARCH_CONTRACT,comIdioma:s=>s,GOOGLE_SUBAGENT_SYSTEM:'Offline'};
  return new Function(...Object.keys(deps),source.slice(start,end)+';return runGoogleSubagent;')(...Object.values(deps));
}

test('duas caixas reais do conector em simulação: origem correta, vazio e preferência preservada',async()=>{
  const previous=globalThis.fetch;const requests=[];const coverage=turnSearchCoverage();
  const agent={google_email:work};
  globalThis.fetch=async(url,opts)=>{
    assert.equal(opts.method || 'GET','GET');
    const account=opts.headers.Authorization.slice('Bearer '.length);requests.push(account);
    assert.ok([work,personal].includes(account));
    return {ok:true,json:async()=>String(url).includes('/messages/')
      ? {id:'order',payload:{headers:[{name:'Subject',value:'Pedido enviado'}]},snippet:'Compra sintética'}
      : {messages:account===work ? [{id:'order'}] : []}};
  };
  try {
    const result=await runGoogleReadAccounts({accounts,currentAccount:agent.google_email,requested:[personal,work,personal],objetivo:'Consultar as duas contas',
      createReadTools:async account=>googleTools({token:async()=>account,account,caps:{gmail:{read:true}}}).filter(t=>t.name==='gmail_search'),
      runWorker:async args=>{
        let step=0;
        const provider={name:'offline',complete:async({messages})=>{
          assert.ok(messages.some(m=>String(m.content).includes(`CONTA DESTA CONSULTA: ${args.account}`)));
          return ++step===1 ? {stop:'tool',toolCalls:[{id:'s',name:'gmail_search',args:{query:'Loja after:2026/09/01'}}]}
            : {stop:'end',text:'Resultado consultado.'};
        }};
        return worker(provider)({...args,onPagination:coverage.observe,onEmailEvidence:coverage.observeEmail,onEmailCoverage:coverage.observeEmailCoverage});
      },onAccountCoverage:coverage.observeAccountCoverage});
    assert.deepEqual(requests,[personal,work,work]);
    assert.equal(agent.google_email,work);
    assert.ok(result.includes(`CONTA: ${work}`));assert.ok(result.includes(`CONTA: ${personal}`));
    assert.ok(result.includes('"returned":0'));assert.ok(result.includes('"returned":1'));
    const final=coverage.finish('Encontrei o pedido.');
    assert.ok(final.includes(encodeURIComponent(work)));assert.ok(final.includes('Pedido enviado'));
    assert.ok(!final.includes('⚠️'));assert.equal(coverage.finish(final),final);
  } finally {globalThis.fetch=previous;}
});

test('conta inválida não consulta principal; conta explícita e padrão têm seleção independente',async()=>{
  assert.deepEqual(selectGoogleReadAccounts({accounts,currentAccount:work}),[work]);
  assert.deepEqual(selectGoogleReadAccounts({accounts,currentAccount:work,requested:[personal]}),[personal]);
  for(const requested of [[],null,['other@example.invalid'],[work,'other@example.invalid'],[42]]) {
    let calls=0;
    await assert.rejects(runGoogleReadAccounts({accounts,currentAccount:work,requested,createReadTools:()=>{calls++;}}));
    assert.equal(calls,0);
  }
  assert.throws(()=>selectGoogleReadAccounts({accounts,currentAccount:'removed@example.invalid'}));
});

test('falha numa caixa não impede a outra e não vira resultado vazio',async()=>{
  const seen=[],states=[];
  const result=await runGoogleReadAccounts({accounts,currentAccount:work,requested:[personal,work],
    createReadTools:async account=>[{name:'gmail_search',run:async()=>{seen.push(account);if(account===personal)throw Error('401 secret-provider-detail');return '{"messages":[],"has_more":false}';}}],
    runWorker:async({readTools})=>{await readTools[0].run({query:'Loja'});return 'Não encontrei com esses filtros.';},onAccountCoverage:r=>states.push(r)});
  assert.deepEqual(seen,[personal,work]);assert.deepEqual(states.map(r=>r.status),['failed','consulted']);
  assert.ok(!result.includes('secret-provider-detail'));assert.ok(result.includes('Não significa ausência'));
});

test('resposta sem ferramenta e falta de permissões não são consulta concluída',async()=>{
  const states=[];
  await runGoogleReadAccounts({accounts,currentAccount:personal,requested:[personal,work],
    createReadTools:async account=>account===work ? [] : [{name:'gmail_search',run:async()=>{throw Error('should not run');}}],
    runWorker:async()=> 'Não existe nenhum e-mail.',onAccountCoverage:r=>states.push(r)});
  assert.deepEqual(states.map(r=>r.status),['not_consulted','failed']);
});

test('paginação preserva conta, total observado e limitação por consulta',async()=>{
  let response;
  const p=trackEmailPagination([{name:'gmail_search',run:async()=>JSON.stringify(response)}],{account:work});
  response={search_id:'a',has_more:true,messages:[{id:'one'}]};await p.tools[0].run({query:'Loja'});
  response={search_id:'b',has_more:false,messages:[]};await p.tools[0].run({query:'Outra'});
  assert.equal(p.hasPartial(),true);
  response={search_id:'a',has_more:false,messages:[{id:'one'},{id:'two'}]};await p.tools[0].run({query:'Loja'});
  assert.equal(p.hasPartial(),false);
  assert.deepEqual(p.coverage().map(r=>[r.account,r.status,r.returned]),[[work,'complete',2],[work,'complete',0]]);
});

test('erro, corpo cortado e vazio completo permanecem estados distintos',async()=>{
  const p=trackEmailPagination([
    {name:'gmail_search',run:async()=>{throw Error('401');}},
    {name:'gmail_read',run:async()=>JSON.stringify({id:'one',body:'prévia',truncated:true})},
  ],{account:work});
  await assert.rejects(p.tools[0].run({query:'Loja'}));await p.tools[1].run({id:'one'});
  assert.deepEqual(p.coverage().map(r=>[r.status,r.reason,r.returned]),[['failed','query_failed',undefined],['partial','body_truncated',undefined]]);
  const c=turnSearchCoverage();c.observeEmailCoverage(p.coverage());c.observeAccountCoverage({account:personal,status:'not_consulted'});
  const final=c.finish('Não há nada de rastreio. A busca foi feita no Gmail por inteiro.');
  assert.ok(!final.includes('Não há nada'));assert.ok(!final.includes('por inteiro'));
  assert.ok(final.includes('parte do conteúdo dos e-mails não pôde ser lida'));assert.ok(final.includes('a conta não foi consultada'));
  assert.equal(c.finish(final),final);assert.equal(c.finishEmail(final),final);
});

test('regressão de prosa: preserva achado positivo e remove ausência absoluta com cobertura parcial',()=>{
  const text='Encontrei o pedido.\n11/09 — pedido despachado.\n\nA busca foi feita na conta do Gmail por inteiro e não há nada de rastreio lá.\nNenhum aviso de entrega chegou.';
  const out=guardEmailCoverageClaims(text,{partial:true,active:true});
  assert.ok(out.includes('pedido despachado'));assert.ok(!out.includes('por inteiro'));assert.ok(!out.includes('Nenhum aviso'));
  assert.equal(guardEmailCoverageClaims(out,{partial:true,active:true}),out);
  assert.equal(guardEmailCoverageClaims(text),text);
  assert.equal(guardEmailCoverageClaims('Não encontrei rastreio nos e-mails consultados.',{partial:true,active:true}),'Não encontrei rastreio nos e-mails consultados.');
  assert.equal(guardEmailCoverageClaims('> O vendedor disse: não há estoque.',{partial:true,active:true}),'> O vendedor disse: não há estoque.');
  assert.equal(guardEmailCoverageClaims('- [Não há estoque](https://example.invalid/mail)',{partial:true,active:true}),'- [Não há estoque](https://example.invalid/mail)');
  assert.ok(!guardEmailCoverageClaims('Não há rastreio. [Pedido](https://example.invalid/mail)',{partial:true,active:true}).includes('Não há rastreio'));
  assert.ok(!guardEmailCoverageClaims('There are no delivery emails.',{partial:true,active:true,language:'en'}).includes('There are no'));
  assert.ok(!guardEmailCoverageClaims('No hay correos de entrega.',{partial:true,active:true,language:'es'}).includes('No hay'));
});

test('conexão morta vira pedido de reconexão, não falha genérica',async()=>{
  const coverage=[];const msg=a=>`Reconecte ${a}`;
  const dead=[{google_email:personal,access_token:null,refresh_token:null},{google_email:work,access_token:'x',refresh_token:'y'}];
  const result=await runGoogleReadAccounts({accounts:dead,currentAccount:work,requested:[personal,work],objetivo:'agenda',reconnectMessage:msg,
    // a conta viva morre no meio (invalid_grant) e a ferramenta engole o erro
    createReadTools:async(account,wrapToken)=>{assert.equal(account,work);const token=wrapToken(async()=>{throw googleReconnectError('morreu');});
      return [{name:'calendar_list',run:async()=>{try{await token();}catch(e){return JSON.stringify({error:e.message});}}}];},
    runWorker:async({readTools})=>{await readTools[0].run({});return 'nada';},onAccountCoverage:r=>coverage.push(r)});
  assert.deepEqual(coverage.map(r=>r.status),['needs_reconnect','needs_reconnect']);
  assert.ok(result.includes(`ESTADO: needs_reconnect\nReconecte ${personal}`));assert.ok(result.includes(`Reconecte ${work}`));
  assert.ok(!result.includes('Não consegui concluir'));
});
