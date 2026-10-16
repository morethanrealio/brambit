import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionJournal } from '../web/action-evidence.mjs';

// Shapes taken from the "ja_fiz_sem_prova" cuts of 2026-09-30 to 2026-10-11,
// rewritten with neutral data. A sentence that only describes, denies or asks
// stays; a sentence that asserts our own completed action without a receipt
// is still removed.
const kept = text => assert.equal(createActionJournal().finish(text), text, text);
const cut = text => assert.notEqual(createActionJournal().finish(text), text, text);
const reminder = j => j.toolResult({ name:'criar_lembrete', args:{ mensagem:'levar a toalha' } },
  JSON.stringify({ ok:true, action_evidence:{ version:1, state:'scheduled', id:'r-1', target:'WhatsApp', at:'09/10/2026, 07:00', subject:'levar a toalha' } }));

test('participles that describe an email, an event or a result are not claims', () => {
  for (const text of [
    'Você recebeu 3 mensagens enviadas pela escola.',
    '• **Papelaria Exemplo** (NF-e 120, enviada por Carlos Souza) — vencimento 30/10, conforme o e-mail.',
    'A reunião (convite enviado 29/09) segue de pé.',
    'O boleto foi enviado por e-mail pela empresa em 10/09.',
    'O pedido da loja foi faturado e enviado em 02/10.',
    'A demanda da equipe de vendas está registrada no quadro deles.',
    'O arquivo guardado na pasta tem 2 páginas.',
    'Entrega: relatório final com o material guardado e as evidências enviadas.',
    'A consulta aos enviados devolveu 1 mensagem desde 04/10.',
    'O e-mail da Ana diz: "Oi, tudo bem? Te mandei uma mensagem pelo WhatsApp ontem."',
  ]) kept(text);
});

test('negated, conditional and question clauses are not claims', () => {
  for (const text of [
    'Não mandei nenhum lembrete hoje.',
    'As alterações não estão salvas na memória.',
    'Nada foi criado ou guardado na memória ainda.',
    'Ou prefere que a lista fique guardada como está?',
    'Confira se o lembrete foi cancelado no aplicativo.',
    'Os pagamentos sem comprovante registrado ficam na lista de pendências.',
  ]) kept(text);
});

test('a state without the memory noun is not a memory claim; with it, it is', () => {
  kept('Isso é seu, está anotado como regra da casa.');
  cut('Isso está anotado na sua memória de saúde, pra eu lembrar você antes da consulta.');
});

test('restating what a read tool returned is not a claim', () => {
  const text = 'As alterações estão **salvas no rascunho**, mas ainda **não publiquei** essa versão.';
  const j = createActionJournal();
  j.toolResult({ name:'consultar_programacao', args:{} }, JSON.stringify({ ok:true, text:'As alterações desta etapa estão salvas. Ainda não publiquei essa versão.' }));
  assert.equal(j.finish(text), text);
  cut(text);
});

test('a record claim naming another place is proven by a real record receipt', () => {
  for (const text of ['Anotado: **sexta, 09/10, às 7h** no WhatsApp.', 'Anotei: amanhã às 7h, pelo WhatsApp, levar a toalha.', 'Prontinho: alarme das 7h agora vai pro WhatsApp (cancelei o do Telegram).']) {
    const j = createActionJournal();
    reminder(j);
    // The receipt takes the claim's place instead of the claim being dropped.
    const out = j.finish(`${text} Qualquer coisa me avisa.`);
    assert.match(out, /^Lembrete agendado[^]*Qualquer coisa me avisa\.$/, text);
  }
  // A send claim is not a record: a scheduled reminder does not prove it.
  const j = createActionJournal();
  reminder(j);
  assert.doesNotMatch(j.finish('Enviei a mensagem no WhatsApp.'), /Enviei/);
});

test('own claims and done headlines without a receipt are still removed', () => {
  for (const text of [
    'Anotado o que mudou: ontem sem blocos, hoje sem espaço.',
    'Anotei: **13/10 (terça)**, início do curso.',
    'Obrigado, anotei que o hotel já está pago.',
    'Kkkk boa, anotado: você já tem isso.',
    'Já anotei mentalmente o destino da viagem.',
    'Os itens básicos da lista entraram na revisão que foi enviada ao fornecedor hoje às 20h.',
    'Certo, Ana, anotado.',
    'Mensagem enviada pelo WhatsApp.',
    'O e-mail para a Ana foi enviado.',
    'Seu lembrete das 9h está agendado.',
    'Deixei anotado na memória.',
    'Lembrete agendado e mensagem enviada.',
    'Os 3 lembretes foram cancelados.',
    // Claims about an earlier turn: this turn has no receipt for them.
    '- **Agendei** o lembrete das 19h de ontem.',
  ]) cut(text);
});

// A memory save has no time or recipient to get wrong: the model's own words stay
// and no receipt is appended. Before 2026-10-13, "Informação salva na memória
// permanente" went into 142 replies in 14 days and the model started copying it.
test('a proven memory save keeps the model words and adds no receipt', () => {
  const save = j => JSON.parse(j.toolResult({ name:'memoria_anotar', args:{ pagina:'perfil' } }, 'Memória atualizada: perfil'));
  const j = createActionJournal();
  const out = save(j);
  assert.equal(out.confirmation_ref, undefined);
  assert.equal(out.confirmation, undefined);
  assert.equal(j.finish('Anotei que seu aniversário é 12/03.'), 'Anotei que seu aniversário é 12/03.');
  assert.equal(j.finish('Pronto.'), 'Pronto.');
  // Never silence: an empty answer still says what happened.
  assert.equal(j.finish(''), 'Informação salva na memória permanente.');
  // A reminder in the same turn keeps its receipt.
  const mixed = createActionJournal();
  save(mixed); reminder(mixed);
  const text = mixed.finish('Anotei e agendei o lembrete.');
  assert.match(text, /Lembrete agendado/);
  assert.doesNotMatch(text, /memória permanente/);
  // Without the save, "anotei" is still removed.
  cut('Anotei que seu aniversário é 12/03.');
});
