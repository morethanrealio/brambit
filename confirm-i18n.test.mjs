import { confirmedAction } from './web/action-evidence.mjs';
// Offline test of the confirmation gate's texts in en/es.
// Nothing goes out to the network, nothing touches the database. Run with: node confirm-i18n.test.mjs
//
// What this file defends, in order of importance:
//  1. pt-BR didn't change. It's the only language in production today; any difference
//     here is pure regression, with no gain for anyone.
//  2. Every tool in the gate has a phrase in all three languages, in BOTH tenses. This is
//     checked against GATED_TOOLS, not against a list I wrote by
//     hand: a new tool enters the gate and the test demands the translation.
//  3. What the user reads has no leaked Portuguese, no "undefined", no
//     loose interpolation.
import { GATED_TOOLS, describe, describeDone, renderConfirmed, avisoEnderecoTrocado } from './web/confirm.mjs';
import { pedidoEm, feitoEm, molduraEm, quando } from './web/confirm-textos.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const TOOLS = [...GATED_TOOLS];
const LANGS = ['en', 'es'];

// Plausible args per tool, so the phrase comes out properly assembled instead of just
// hitting the placeholder path. A tool with no entry here is called with {},
// which is also a real case (the model sending an incomplete call).
const ARGS = {
  jornada_configurar: {action:'accept',channel:'telegram',lunch:'12:30',evening:'20:30',timezone:'America/Sao_Paulo',duration:7,frequency:'twice',sensitive:false},
  jornada_editar_nota: {action:'correct',text:'Review the week'},
  gmail_send: { to: 'ana@x.com', subject: 'Proposta' },
  hotmail_send: { to: 'ana@x.com', subject: 'Proposta' },
  gmail_label_delete: { marcador: 'Clientes' },
  gmail_filter_create: { de: 'ana@x.com', assunto: 'Nota', marcador: 'Fiscal', marcar_lido: true },
  calendar_create: { summary: 'Call', start: '2026-07-09T11:30:00+02:00', timezone: 'Europe/Zurich' },
  calendar_update: { title: 'Call 2', start: '2026-07-09T15:00:00-03:00', location: 'Zoom', attendees: ['a@x.com'] },
  outlook_calendar_create: { titulo: 'Call', inicio: '2026-12-01T09:00:00-03:00' },
  outlook_calendar_update: { titulo: 'Call 2', inicio: '2026-12-01T10:00:00-03:00', local: 'Teams' },
  drive_upload: { name: 'contrato.pdf' },
  docs_create: { name: 'Ata da reunião' },
  drive_export_pdf: { id: 'abc123', name: 'Ata da reunião' },
  drive_upload_arquivo: { nome: 'contrato.pdf' },
  enviar_para_drive: { nome: 'contrato.pdf' },
  onedrive_upload: { nome: 'contrato.pdf' },
  onedrive_upload_arquivo: { nome: 'contrato.pdf' },
  github_create_issue: { repo: 'org/app', title: 'Erro no login' },
  github_comment_issue: { repo: 'org/app', number: 12 },
  slack_post_message: { channel: '#geral' },
  linkedin_post: { text: 'Texto do post', link: 'https://x.com', visibility: 'CONNECTIONS' },
  confirmar_com_agente: { contato: 'Ana', decisao: 'fechado' },
  responder_decisao: { aceito: true, de: 'Ana', mensagem: 'ok' },
  rodar_no_servidor: { comando: 'ls -la', host: 'web-1' },
  editar_arquivo: { caminho: '/app/x.js', host: 'web-1' },
  escrever_arquivo: { caminho: '/app/x.js', host: 'web-1' },
  rodar_comando: { comando: 'ls -la', host: 'web-1' },
  git_commit: { mensagem: 'fix', diretorio: '/app', adicionar_tudo: false },
  git_push: { branch: 'main', remote: 'origin', diretorio: '/app' },
  git_branch: { nome: 'feat/x', base: 'main', diretorio: '/app' },
  git_checkout: { ref: 'main', diretorio: '/app' },
  publicar_sistema: { nome_do_sistema: 'loja', runtime: 'node' },
  criar_rotina: { titulo: 'Resumo', dias_da_semana: ['seg', 'qua'], hora: 18, canal: 'whatsapp' },
  editar_rotina: { titulo: 'Resumo', novo_titulo: 'Resumo 2', hora: 9, dias: 'weekdays' },
  convidar_colaborador: { contato: 'Ana', nome_do_sistema: 'loja' },
  convidar_para_espaco: { contato: 'Ana', espaco: 'Casa' },
  instalar_skill: { skill: 'notas', de: 'Ana' },
  compartilhar_skill: { skill: 'notas', contato: 'Ana' },
  rodar_skill: { skill: 'notas', argumento: 'hoje' },
  canva_criar: { objetivo: 'um post' },
  canva_editar: { objetivo: 'trocar a cor' },
  notion_create_page: { titulo: 'Ideias' },
  splitwise_add_expense: { descricao: 'Jantar', valor: 120, moeda: 'BRL' },
  infinity_criar_item: { board_id: 'b1', folder_id: 'f1', campos: { Name: 'Call supplier', Status: 'Doing' } },
  infinity_editar_item: { board_id: 'b1', item_id: 'i1', campos: { Status: 'Done' } },
  infinity_comentar: { board_id: 'b1', item_id: 'i1', texto: 'Ok' },
  asaas_pagar_conta: { valor: 250.5, linha_digitavel: '8364000...', agendar_para: '2026-10-01' },
  asaas_transferir_pix: { valor: 300, chave_pix: 'ana@x.com', tipo_chave: 'EMAIL' },
  salvar_credencial: { servico: 'Stripe' },
  criar_conta_brambs: { nome: 'Ana', cpf_cnpj: '000', email: 'a@x.com', celular: '11999', endereco: 'Rua X', numero: '10', bairro: 'Centro', cep: '01000', renda_mensal: 5000 },
  apagar_sistema: { nome_do_sistema: 'loja' },
  replicar_sistema: { origem: 'loja', novo_nome: 'loja2' },
  voltar_versao: { nome_do_sistema: 'loja', versao: '3' },
  remover_arquivo_do_app: { caminho: 'index.js', nome_do_sistema: 'loja' },
  remover_segredo: { chave: 'API_KEY', nome_do_sistema: 'loja' },
};
const argsDe = (name) => ARGS[name] || {};

// 1) THE SAFETY PROPERTY: in pt-BR nothing changes, byte for byte. This holds for
//    all three ways of calling (no language, with null, with 'pt-BR'/'pt-PT'), because
//    that's what happens in production: a thread with no language annotated, a
//    Portuguese user, and the value coming from the database.
for (const name of TOOLS) {
  const a = argsDe(name);
  const base = describe(name, a);
  const baseF = describeDone(name, a);
  t(`pt-BR intacto (pedido): ${name}`,
    base === describe(name, a, null) && base === describe(name, a, 'pt-BR') && base === describe(name, a, 'pt-PT'));
  t(`pt-BR intacto (feito): ${name}`,
    baseF === describeDone(name, a, null) && baseF === describeDone(name, a, 'pt-BR') && baseF === describeDone(name, a, 'pt-PT'));
  // A language we do NOT support falls back to the default, not to empty text.
  t(`idioma não atendido cai no pt-BR: ${name}`, describe(name, a, 'ja') === base && describeDone(name, a, 'ja') === baseF);
}

// 2) COVERAGE checked against GATED_TOOLS. If someone puts a new tool in the
//    gate and forgets the translation, the failure shows up here and not on the
//    user's card. `remover_arquivo_do_app`/`remover_segredo` fall into this bucket:
//    in pt they fall back to the generic one, but in en/es they have their own phrase.
for (const lang of LANGS) {
  for (const name of TOOLS) {
    t(`${lang} tem frase de pedido: ${name}`, typeof pedidoEm(lang, name, argsDe(name)) === 'string');
    t(`${lang} tem frase de feito: ${name}`, typeof feitoEm(lang, name, argsDe(name)) === 'string');
  }
}

// 3) The text that comes out can NOT have assembly defects. "undefined" and "${" in a
//    confirmation card are the worst case: the owner authorizes a broken phrase.
// Leaked-Portuguese markers. Only words that exist in
// Portuguese and NOT in Spanish can be used: "pedido", "marcador" and "de verdad" are legitimate
// Spanish, and using them as a marker would accuse a correct Spanish phrase
// of being Portuguese (that's exactly what this test did on the first run, with
// `fechar_pedido`). The pair has to diverge: arquivo≠archivo,
// senha≠contraseña, dinheiro≠dinero, rotina≠rutina, também≠también,
// você/seu/sua≠su, não≠no, endereço≠dirección.
// JS's `\b` is ASCII and closes right after an accented letter, so here
// (?<!\p{L})/(?!\p{L}) with the u flag applies, the same trap as the "para" bug.
const MARCAS_PT = /(?<!\p{L})(arquivo|senha|dinheiro|rotina|também|você|voce|seu|sua|não|nao|endereço|planilha|de verdade|enviar um|excluíd\p{L}*)(?!\p{L})/iu;
// Before using the detector, prove that it FIRES. A regex that doesn't match
// anything glosses over any leak and the test turns green by mistake; and the
// list above was just narrowed, which is exactly when this happens.
// These are real pt-BR phrases from confirm.mjs, which is what would show up on an
// English card if that tool's translation was missing.
[
  ['gmail_send', describe('gmail_send', { to: 'ana@x.com' })],
  ['salvar_credencial', describe('salvar_credencial', { servico: 'Stripe' })],
  ['criar_rotina', describe('criar_rotina', { titulo: 'Ping' })],
  ['drive_upload', describe('drive_upload', { name: 'x.pdf' })],
  ['asaas_transferir_pix', describe('asaas_transferir_pix', ARGS.asaas_transferir_pix)],
].forEach(([nome, pt]) => t(`detector pega o pt-BR de ${nome}`, MARCAS_PT.test(pt)));

for (const lang of LANGS) {
  for (const name of TOOLS) {
    for (const [rotulo, texto] of [['pedido', describe(name, argsDe(name), lang)], ['feito', describeDone(name, argsDe(name), lang)]]) {
      t(`${lang}/${rotulo} ${name}: sem \${ solto`, !texto.includes('${'));
      t(`${lang}/${rotulo} ${name}: sem undefined/NaN`, !/\bundefined\b|\bNaN\b|\[object Object\]/.test(texto));
      t(`${lang}/${rotulo} ${name}: não vazio`, texto.trim().length > 3);
      t(`${lang}/${rotulo} ${name}: sem português vazado`, !MARCAS_PT.test(texto));
    }
  }
}
// EMPTY args also can't produce garbage: the model sends an incomplete call
// and the card remains what the owner reads before authorizing.
for (const lang of LANGS) {
  for (const name of TOOLS) {
    const p = describe(name, {}, lang);
    const f = describeDone(name, {}, lang);
    t(`${lang} com args vazios não quebra: ${name}`,
      !/\bundefined\b|\$\{|\[object Object\]/.test(p) && !/\bundefined\b|\$\{|\[object Object\]/.test(f));
  }
}

// 4) Date and time. The old rule (show the WALL-CLOCK time, without converting
//    time zones) has to hold across all three languages: it's what fixed the user in
//    Basel seeing 06:30 instead of 11:30.
t('en não converte fuso', quando('2026-07-09T11:30:00+02:00', 'en').includes('11:30'));
t('es não converte fuso', quando('2026-07-09T11:30:00+02:00', 'es').includes('11:30'));
// In English the day CANNOT come out as a number: 09/07 is July 9 for one reader and
// September 7 for another, and the owner is approving a calendar schedule time.
t('en usa mês por nome', quando('2026-07-09T11:30:00-03:00', 'en') === 'Jul 9, 2026, 11:30');
t('en em data seca', quando('2026-07-09', 'en') === 'Jul 9, 2026');
t('es mantém DD/MM', quando('2026-07-09T11:30:00-03:00', 'es') === '09/07/2026, 11:30');
t('es em data seca', quando('2026-07-09', 'es') === '09/07/2026');
// Unexpected format returns the original, does not invent a date.
['', null, undefined, 'amanhã', '2026-13', 0, {}].forEach((v) => {
  t(`data inválida ${JSON.stringify(v)} não inventa`, [''].includes(quando(v, 'en')) || quando(v, 'en') === String(v).trim());
});

// 5) Routine cadence. The bug this snippet exists to keep from coming back: in
//    INTERVAL mode there is no day or hour, and the sentence came out as "todo dia às 0?h", that
//    is, it described a routine different from the one that was going to be created.
for (const lang of LANGS) {
  const intervalo = describe('criar_rotina', { titulo: 'Ping', repetir_cada_min: 30, repetir_ate: '2026-12-31' }, lang);
  t(`${lang}: intervalo não fala de hora fixa`, /30 min/.test(intervalo) && !/07:00/.test(intervalo));
  t(`${lang}: intervalo diz até quando`, intervalo.includes('2026-12-31'));
  const semFim = describe('criar_rotina', { titulo: 'Ping', repetir_cada_min: 120 }, lang);
  t(`${lang}: intervalo sem fim é declarado`, /2 (hours|horas)/.test(semFim) && /(no end date|sin fecha)/.test(semFim));
  // Fixed time: day and hour appear.
  const fixo = describe('criar_rotina', { titulo: 'Resumo', dias_da_semana: ['seg', 'qua'], hora: 18 }, lang);
  t(`${lang}: dias da semana aparecem`, /(Monday|lunes)/.test(fixo) && /(Wednesday|miércoles)/.test(fixo) && fixo.includes('18:00'));
  // Day of the month that doesn't exist in every month: the owner has to know what happens
  // in February before confirming.
  const mes = describe('criar_rotina', { titulo: 'Fatura', dias_do_mes: [31] }, lang);
  t(`${lang}: dia 31 avisa dos meses curtos`, /(shorter months|meses más cortos)/.test(mes));
  // Nth occurrence in the month.
  const nth = describe('criar_rotina', { titulo: 'Fechamento', semana_do_mes: -1, dias_da_semana: ['sex'] }, lang);
  t(`${lang}: última sexta do mês`, /(last Friday of the month|último viernes del mes)/.test(nth));
  // Without cadence informed, the default is every day (that's what the platform records).
  const diario = describe('criar_rotina', { titulo: 'Bom dia' }, lang);
  t(`${lang}: default é todo dia`, /(every day|todos los días)/.test(diario));
}

// 6) renderConfirmed: this is the DETERMINISTIC text, printed directly to the user without
//    the model in between. The language comes from the pending request (recorded in the
//    request), not from re-reading, so the request/result pair comes out in the same language.
const pendPt = { name: 'gmail_send', args: { to: 'ana@x.com' }, label: 'enviar um e-mail para ana@x.com' };
t('pt-BR: recibo real distingue envio de entrega', renderConfirmed(pendPt, { ok: true, id:'fixture-mail' }) === confirmedAction('gmail_send',pendPt.args,{ok:true,id:'fixture-mail'},'pt-BR'));
t('pt-BR: falha igual à de antes',
  renderConfirmed(pendPt, { ok: false, error: 'quota.' }) === '❌ Não consegui concluir: enviar um e-mail para ana@x.com. quota.');
t('pt-BR: stderr igual ao de antes',
  renderConfirmed(pendPt, { ok: true, id:'fixture-mail', stderr: 'aviso' }) === confirmedAction('gmail_send',pendPt.args,{ok:true,id:'fixture-mail'},'pt-BR') + '\n\n_stderr:_\naviso');
// A pending request WITHOUT the language field (recorded before this change, or restored from
// the database) has to behave as pt-BR, not come out empty.
t('pendência antiga cai no pt-BR', renderConfirmed({ ...pendPt, language: undefined }, { ok: true, id:'fixture-mail' }).startsWith('Envio aceito'));

const pendEn = { name: 'gmail_send', args: { to: 'ana@x.com' }, label: describe('gmail_send', { to: 'ana@x.com' }, 'en'), language: 'en' };
t('en: sucesso em inglês', renderConfirmed(pendEn, { ok: true, id:'fixture-mail' }) === confirmedAction('gmail_send',pendEn.args,{ok:true,id:'fixture-mail'},'en'));
t('en: falha em inglês', renderConfirmed(pendEn, { ok: false, error: 'quota.' }) === "❌ I couldn't finish: send an email to ana@x.com. quota.");
const pendEs = { name: 'gmail_send', args: { to: 'ana@x.com' }, label: describe('gmail_send', { to: 'ana@x.com' }, 'es'), language: 'es' };
t('es: sucesso em espanhol', renderConfirmed(pendEs, { ok: true, id:'fixture-mail' }) === confirmedAction('gmail_send',pendEs.args,{ok:true,id:'fixture-mail'},'es'));
t('es: falha em espanhol', renderConfirmed(pendEs, { ok: false, error: 'quota.' }) === '❌ No pude terminar: enviar un correo a ana@x.com. quota.');
// Textual refusal is preserved; it does not turn into a generic success via describeDone.
t('texto puro preservado sem inventar sucesso/tradução', renderConfirmed(pendEn, 'Não enviado: erro.') === 'Não enviado: erro.');
// Command output: the body comes raw from the tool (it is shell output, it is not
// translated), but the frame around it is translated.
const pendCmd = { name: 'rodar_comando', args: { comando: 'ls' }, label: 'x', language: 'en' };
t('en: stderr traduzido na moldura', renderConfirmed(pendCmd, { ok: true, saida: 'a.txt', stderr: 'warn' })
  === '✅ Command executed on the server.\n\na.txt\n\n_stderr:_\nwarn');

// 7) The changed-address notice goes INSIDE the label, so it also needs
//    language: it's what makes the card flag a recipient "corrected" along
//    the way, and in Portuguese it would slip past anyone who doesn't read Portuguese.
const trocado = (lang) => avisoEnderecoTrocado('ana@x.com', 'manda pra anna@x.com', lang);
t('pt-BR: aviso igual ao de antes', trocado(null).startsWith('CONFIRA O ENDEREÇO:') && trocado('pt-BR') === trocado(null));
t('en: aviso em inglês', trocado('en').startsWith('CHECK THE ADDRESS:') && trocado('en').includes('anna@x.com') && trocado('en').includes('ana@x.com'));
t('es: aviso em espanhol', trocado('es').startsWith('REVISA LA DIRECCIÓN:') && trocado('es').includes('anna@x.com'));
// The narrow rule doesn't change with language: without an address written by the owner, silent.
LANGS.concat(['pt-BR']).forEach((l) => {
  t(`${l}: sem endereço escrito não avisa`, avisoEnderecoTrocado('ana@x.com', 'manda pra Ana', l) === '');
  t(`${l}: endereço claramente outro não avisa`, avisoEnderecoTrocado('ana@x.com', 'manda pra joao@y.com', l) === '');
});

// 8) A tool that is NOT at the gate (or doesn't even exist) falls back to the generic text of the
//    language, without turning into Portuguese on the card of someone who speaks English.
t('en: tool desconhecida vira genérico em inglês', describe('tool_que_nao_existe', {}, 'en') === 'run the action "tool_que_nao_existe"');
t('es: tool desconhecida vira genérico em espanhol', describeDone('tool_que_nao_existe', {}, 'es') === 'Acción "tool_que_nao_existe" completada.');
t('pt-BR: genérico igual ao de antes',
  describe('tool_que_nao_existe', {}) === 'executar a ação "tool_que_nao_existe"'
  && describeDone('tool_que_nao_existe', {}) === 'Ação "tool_que_nao_existe" concluída.');

// 9) DECLARED LIMIT: the CART summary (compras.mjs) stays in Portuguese
//    across all three languages at this stage. It's not an oversight; it's here so no one
//    says that `fechar_pedido` is translated end to end.
t('moldura existe em en e es', !!molduraEm('en') && !!molduraEm('es'));
t('moldura não existe em pt-BR (é o caminho intacto)', molduraEm('pt-BR') === null);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);

// 8) Tool that returns a ready-made phrase in pt-BR (criar_rotina): whoever confirmed in
//    English or Spanish received "Rotina X criada" in Portuguese (dev, 2026-10-03).
const rotinaPt = 'Rotina "Daily quote" criada: roda todo dia às 08h (America/Sao_Paulo). Vou executar sozinho a partir da próxima vez que der o horário.';
const pendRot = lang => ({ name: 'criar_rotina', args: { titulo: 'Daily quote', hora: 8 }, label: 'x', language: lang });
t('en: rotina criada em inglês', renderConfirmed(pendRot('en'), rotinaPt).startsWith('Routine "Daily quote" created'));
t('es: rotina criada em espanhol', renderConfirmed(pendRot('es'), rotinaPt).startsWith('Rutina "Daily quote" creada'));
t('pt-BR: frase da tool intacta', renderConfirmed(pendRot('pt-BR'), rotinaPt) === rotinaPt);
