import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionJournal } from './web/action-evidence.mjs';
import { turnSearchCoverage } from './web/turn-search-coverage.mjs';

const personal = 'https://mail.google.com/mail/?authuser=personal%40example.test#all/111';
const work = 'https://mail.google.com/mail/?authuser=work%40example.test#all/222';
const lines = [
  `O último e-mail foi em 26/08 e diz que o pedido foi embalado e enviado à transportadora. [e-mail de envio](${personal})`,
  `O último e-mail foi em 11/09 e também diz que foi enviado à transportadora. [e-mail de envio](${work})`,
];

test('preserva datas de envio e fontes das duas contas em relatos atribuídos aos e-mails', () => {
  const answer = `Encontrei duas compras.\n\n${lines.join('\n\n')}\n\nQual delas você não recebeu?`;
  assert.equal(createActionJournal().finish(answer), answer);
});

test('relatos de documento sobre objetos externos não viram recibos próprios', () => {
  for (const text of [
    'Segundo o e-mail, o pedido foi enviado em 18/09.',
    'Conforme a mensagem, a fatura foi cancelada e substituída.',
    'O comunicado informa que a reserva foi remarcada para quinta.',
    'A mensagem confirma que o pacote foi enviado pela loja.',
  ]) assert.equal(createActionJournal().finish(text), text);
});

test('preserva atribuição plural após contexto de conta, inclusive entrega contestada e fontes', () => {
  const report = `Na conta de trabalho, as mensagens sobre o B-902 dizem que o pedido foi enviado em 18/09, com prazo de entrega em 21/09/2026 ([pedido enviado](${personal})), e que o sistema da transportadora registrou o B-902 como entregue em 21/09/2026 às 14h20, com recebedor informado 'portaria' ([entrega registrada](${work})).`;
  assert.equal(createActionJournal().finish(report), report);
  for (const text of [
    'Sobre a reserva R-17, os últimos e-mails informam que a reserva foi remarcada para quinta.',
    'Na conta de trabalho, a mensagem confirma que a fatura foi cancelada.',
    'Na busca da conta pessoal, segundo os e-mails, o pacote foi enviado à transportadora.',
    'As mensagens registram que o pedido foi enviado.',
    'Nas duas há aviso de que o pedido foi enviado à transportadora; não encontrei, nas mensagens consultadas, confirmação de entrega nem código de rastreio.',
    'Na conta de trabalho, há uma mensagem de que a reserva foi remarcada.',
    'Nas duas contas há avisos de que o pacote foi enviado.',
  ]) assert.equal(createActionJournal().finish(text), text);
});

test('prefixo de contexto e atribuição plural não validam recibos próprios', () => {
  for (const text of [
    'Na conta de trabalho, as mensagens dizem que enviei o pedido ao suporte.',
    'Sobre o pedido, os e-mails informam que foi enviado por nós.',
    'As mensagens informam que o pedido foi enviado pelo nosso assistente.',
    'Na conta pessoal, os e-mails dizem que o pedido foi enviado e registrei o bug.',
    'O lembrete foi agendado; as mensagens dizem que o pedido foi enviado.',
    'Nas duas há aviso de que enviei o pedido ao suporte.',
    'Nas duas contas há avisos de que o pedido foi enviado por mim.',
  ]) assert.match(createActionJournal().finish(text), /Não consegui confirmar/, text);
});

test('a atribuição e os links não liberam confirmações próprias sem recibo', () => {
  for (const text of [
    `Enviei o e-mail sobre o pedido. [fonte](${personal})`,
    'O e-mail foi enviado.',
    'Pedido enviado ao time.',
    'O e-mail informa que enviei o pedido para o suporte.',
    'Segundo o e-mail, o pedido foi enviado por mim.',
    'O e-mail informa que o pedido foi enviado pelo assistente.',
    'Segundo o e-mail, o pedido foi enviado e já registrei o bug.',
    'Segundo o e-mail, o lembrete foi agendado.',
  ]) {
    const out = createActionJournal().finish(text);
    assert.notEqual(out, text, text);
    assert.match(out, /Não consegui confirmar/, text);
  }
});

test('mantém relato externo em turno misto e usa recibo real só para envio próprio', () => {
  const journal = createActionJournal();
  journal.toolResult({ name:'gmail_send', args:{ to:'suporte@example.test', subject:'Meu pedido' } }, {ok:true,id:'sent-fixture'});
  const out = journal.finish(`${lines[0]}\n\nEnviei o e-mail para outra pessoa.`);
  assert.ok(out.includes(lines[0]));
  assert.match(out, /Envio aceito pelo serviço/);
  assert.match(out, /suporte@example.test/);
  assert.doesNotMatch(out, /outra pessoa/);
  assert.equal((out.match(/Envio aceito pelo serviço/g) || []).length, 1);
});

test('elimina confirmação própria na frase seguinte sem apagar a evidência anterior', () => {
  const report = 'O último e-mail diz que o pedido foi enviado à transportadora.';
  assert.equal(createActionJournal().finish(`${report} Enviei a mensagem ao suporte.`), report);
});

test('composição com cobertura final preserva os links e evita fontes substitutas', () => {
  const coverage = turnSearchCoverage();
  coverage.observeEmail([
    { provider:'gmail', id:'111', account:'personal@example.test', subject:'Pedido enviado', link:personal },
    { provider:'gmail', id:'222', account:'work@example.test', subject:'Pedido enviado', link:work },
  ]);
  const answer = lines.join('\n\n');
  const final = coverage.finishEmail(createActionJournal().finish(answer), 'pt-BR');
  assert.equal(final, answer);
  assert.ok(final.includes(personal));
  assert.ok(final.includes(work));
});

test('achados com fonte observada preservam estado, datas e identidade sem exigir formato de prosa', () => {
  const coverage = turnSearchCoverage();
  coverage.observeEmail([
    {provider:'gmail',account:'personal@example.test',id:'111',link:personal},
    {provider:'gmail',account:'work@example.test',id:'222',link:work},
  ]);
  const answer = `- Conta de trabalho: pedido P-17, item azul, comprado em 08/09/2026, enviado em 10/09/2026, previsto até 16/09/2026. [e-mail do pedido](${work})\n- Conta pessoal: pedido P-23, item preto, comprado em 12/09/2026, enviado em 14/09/2026, previsto até 19/09/2026. [mensagem](${personal})`;
  const out=createActionJournal().finish(answer,{authenticatedEmailSources:coverage.emailSourceLinks()});
  assert.equal(out,answer);
  assert.equal(coverage.finishEmail(out,'pt-BR'),answer);
  const readClaim=`Eu encontrei o pedido enviado em 10/09, previsto até 16/09. [e-mail](${work})`;
  assert.equal(createActionJournal().finish(readClaim,{authenticatedEmailSources:coverage.emailSourceLinks()}),readClaim);
  const unknown=createActionJournal().finish(answer,{authenticatedEmailSources:new Set([personal])});
  assert.ok(!unknown.includes('16/09/2026'));
  assert.ok(unknown.includes('19/09/2026'));
});

test('rótulos e URLs de fonte não transformam estados externos em recibos', () => {
  const text=`Material enviado em 10/09, previsão 16/09. [e-mail de envio](${work})`;
  assert.equal(createActionJournal().finish(text),text);
});

test('fonte observada não serve de recibo de ação própria, inclusive em rótulos de link', () => {
  const options={authenticatedEmailSources:new Set([work])};
  for(const statement of [
    'Enviei a mensagem.', 'Pedido enviado ao time.', 'Registrei seu pedido.',
    'Lembrete agendado.', 'Informação salva na memória.', 'Lista salva.',
    'O e-mail foi enviado.', 'Message sent.',
    'Segundo o e-mail, o pedido foi enviado por mim.',
    'I have already sent the email.',
  ])for(const suffix of ['',` [e-mail](${work})`]){
    const out=createActionJournal().finish(statement+suffix,options);
    assert.match(out,/Não consegui confirmar/,statement+suffix);
  }
  assert.match(createActionJournal().finish(`Enviei [o e-mail](${work})`,options),/Não consegui confirmar/);
  assert.match(createActionJournal().finish(`[Enviei o e-mail](${work})`,options),/Não consegui confirmar/);
});
