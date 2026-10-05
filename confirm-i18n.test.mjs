import { confirmedAction } from './web/action-evidence.mjs';
// Teste offline dos textos do portão de confirmação em en/es.
// Nada sai pra rede, nada toca banco. Roda com: node confirm-i18n.test.mjs
//
// O que este arquivo defende, em ordem de importância:
//  1. pt-BR não mudou. É o único idioma em produção hoje; qualquer diferença
//     aqui é regressão pura, sem ganho pra ninguém.
//  2. Toda tool do portão tem frase nas três línguas, nos DOIS tempos. Isto é
//     conferido contra o GATED_TOOLS, não contra uma lista que eu escrevi à
//     mão: tool nova entra no portão e o teste cobra a tradução.
//  3. O que o usuário lê não tem português vazado, nem "undefined", nem
//     interpolação solta.
import { GATED_TOOLS, describe, describeDone, renderConfirmed, avisoEnderecoTrocado } from './web/confirm.mjs';
import { pedidoEm, feitoEm, molduraEm, quando } from './web/confirm-textos.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const TOOLS = [...GATED_TOOLS];
const LANGS = ['en', 'es'];

// Args plausíveis por tool, pra frase sair montada de verdade em vez de só
// bater no caminho dos placeholders. Tool sem entrada aqui é chamada com {},
// que também é um caso real (o modelo mandando chamada incompleta).
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

// 1) A PROPRIEDADE DE SEGURANÇA: em pt-BR nada muda, byte a byte. Vale pros
//    três jeitos de chamar (sem idioma, com null, com 'pt-BR'/'pt-PT'), porque
//    é o que acontece em produção: thread sem idioma anotado, usuário
//    português, e o valor vindo do banco.
for (const name of TOOLS) {
  const a = argsDe(name);
  const base = describe(name, a);
  const baseF = describeDone(name, a);
  t(`pt-BR intacto (pedido): ${name}`,
    base === describe(name, a, null) && base === describe(name, a, 'pt-BR') && base === describe(name, a, 'pt-PT'));
  t(`pt-BR intacto (feito): ${name}`,
    baseF === describeDone(name, a, null) && baseF === describeDone(name, a, 'pt-BR') && baseF === describeDone(name, a, 'pt-PT'));
  // Idioma que a gente NÃO atende cai no padrão, não em texto vazio.
  t(`idioma não atendido cai no pt-BR: ${name}`, describe(name, a, 'ja') === base && describeDone(name, a, 'ja') === baseF);
}

// 2) COBERTURA conferida contra o GATED_TOOLS. Se alguém puser uma tool nova no
//    portão e esquecer a tradução, a falha aparece aqui e não no cartão do
//    usuário. `remover_arquivo_do_app`/`remover_segredo` entram nesta conta:
//    em pt eles caem no genérico, mas em en/es têm frase própria.
for (const lang of LANGS) {
  for (const name of TOOLS) {
    t(`${lang} tem frase de pedido: ${name}`, typeof pedidoEm(lang, name, argsDe(name)) === 'string');
    t(`${lang} tem frase de feito: ${name}`, typeof feitoEm(lang, name, argsDe(name)) === 'string');
  }
}

// 3) O texto que sai NÃO pode ter defeito de montagem. "undefined" e "${" num
//    cartão de confirmação são o pior caso: o dono autoriza uma frase quebrada.
// Marcadores de português vazado. Só podem entrar palavras que existem em
// português e NÃO em espanhol: "pedido", "marcador" e "de verdad" são espanhol
// legítimo, e usá-las como marcador acusa de português uma frase espanhola
// correta (foi exatamente o que este teste fez na primeira rodada, com o
// `fechar_pedido`). O par tem que ser divergente: arquivo≠archivo,
// senha≠contraseña, dinheiro≠dinero, rotina≠rutina, também≠también,
// você/seu/sua≠su, não≠no, endereço≠dirección.
// `\b` do JS é ASCII e fecha depois de letra acentuada, então aqui vale
// (?<!\p{L})/(?!\p{L}) com a flag u — mesma armadilha do bug do "para".
const MARCAS_PT = /(?<!\p{L})(arquivo|senha|dinheiro|rotina|também|você|voce|seu|sua|não|nao|endereço|planilha|de verdade|enviar um|excluíd\p{L}*)(?!\p{L})/iu;
// Antes de usar o detector, provar que ele DISPARA. Uma regex que não casa com
// nada passa em cima de qualquer vazamento e o teste fica verde por engano; e a
// lista acima acabou de ser estreitada, que é justamente quando isso acontece.
// Estas são frases reais do pt-BR do confirm.mjs, que é o que sairia num cartão
// de inglês se a tradução daquela tool faltasse.
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
// Args VAZIOS também não podem produzir lixo: o modelo manda chamada incompleta
// e o cartão continua sendo o que o dono lê antes de autorizar.
for (const lang of LANGS) {
  for (const name of TOOLS) {
    const p = describe(name, {}, lang);
    const f = describeDone(name, {}, lang);
    t(`${lang} com args vazios não quebra: ${name}`,
      !/\bundefined\b|\$\{|\[object Object\]/.test(p) && !/\bundefined\b|\$\{|\[object Object\]/.test(f));
  }
}

// 4) Data e hora. A regra antiga (mostrar o horário de PAREDE, sem converter
//    fuso) tem que valer nas três línguas: foi ela que consertou o usuário na
//    Basileia vendo 06:30 em vez de 11:30.
t('en não converte fuso', quando('2026-07-09T11:30:00+02:00', 'en').includes('11:30'));
t('es não converte fuso', quando('2026-07-09T11:30:00+02:00', 'es').includes('11:30'));
// Em inglês o dia NÃO pode sair como número: 09/07 é 9 de julho pra um leitor e
// 7 de setembro pra outro, e o dono está aprovando um horário de agenda.
t('en usa mês por nome', quando('2026-07-09T11:30:00-03:00', 'en') === 'Jul 9, 2026, 11:30');
t('en em data seca', quando('2026-07-09', 'en') === 'Jul 9, 2026');
t('es mantém DD/MM', quando('2026-07-09T11:30:00-03:00', 'es') === '09/07/2026, 11:30');
t('es em data seca', quando('2026-07-09', 'es') === '09/07/2026');
// Formato inesperado devolve o original, não inventa data.
['', null, undefined, 'amanhã', '2026-13', 0, {}].forEach((v) => {
  t(`data inválida ${JSON.stringify(v)} não inventa`, [''].includes(quando(v, 'en')) || quando(v, 'en') === String(v).trim());
});

// 5) Cadência de rotina. O bug que este trecho existe pra não deixar voltar: no
//    modo INTERVALO não há dia nem hora, e a frase saía "todo dia às 0?h", ou
//    seja, descrevia uma rotina diferente da que ia ser criada.
for (const lang of LANGS) {
  const intervalo = describe('criar_rotina', { titulo: 'Ping', repetir_cada_min: 30, repetir_ate: '2026-12-31' }, lang);
  t(`${lang}: intervalo não fala de hora fixa`, /30 min/.test(intervalo) && !/07:00/.test(intervalo));
  t(`${lang}: intervalo diz até quando`, intervalo.includes('2026-12-31'));
  const semFim = describe('criar_rotina', { titulo: 'Ping', repetir_cada_min: 120 }, lang);
  t(`${lang}: intervalo sem fim é declarado`, /2 (hours|horas)/.test(semFim) && /(no end date|sin fecha)/.test(semFim));
  // Horário fixo: dia e hora aparecem.
  const fixo = describe('criar_rotina', { titulo: 'Resumo', dias_da_semana: ['seg', 'qua'], hora: 18 }, lang);
  t(`${lang}: dias da semana aparecem`, /(Monday|lunes)/.test(fixo) && /(Wednesday|miércoles)/.test(fixo) && fixo.includes('18:00'));
  // Dia do mês que não existe em todo mês: o dono tem que saber o que acontece
  // em fevereiro antes de confirmar.
  const mes = describe('criar_rotina', { titulo: 'Fatura', dias_do_mes: [31] }, lang);
  t(`${lang}: dia 31 avisa dos meses curtos`, /(shorter months|meses más cortos)/.test(mes));
  // Nª ocorrência no mês.
  const nth = describe('criar_rotina', { titulo: 'Fechamento', semana_do_mes: -1, dias_da_semana: ['sex'] }, lang);
  t(`${lang}: última sexta do mês`, /(last Friday of the month|último viernes del mes)/.test(nth));
  // Sem cadência informada, o default é todo dia (é o que a plataforma grava).
  const diario = describe('criar_rotina', { titulo: 'Bom dia' }, lang);
  t(`${lang}: default é todo dia`, /(every day|todos los días)/.test(diario));
}

// 6) renderConfirmed: é o texto DETERMINÍSTICO, impresso direto pro usuário sem
//    o modelo no meio. O idioma vem da pendência (gravado no pedido), não de
//    releitura, pra o par pedido/resultado sair na mesma língua.
const pendPt = { name: 'gmail_send', args: { to: 'ana@x.com' }, label: 'enviar um e-mail para ana@x.com' };
t('pt-BR: recibo real distingue envio de entrega', renderConfirmed(pendPt, { ok: true, id:'fixture-mail' }) === confirmedAction('gmail_send',pendPt.args,{ok:true,id:'fixture-mail'},'pt-BR'));
t('pt-BR: falha igual à de antes',
  renderConfirmed(pendPt, { ok: false, error: 'quota.' }) === '❌ Não consegui concluir: enviar um e-mail para ana@x.com. quota.');
t('pt-BR: stderr igual ao de antes',
  renderConfirmed(pendPt, { ok: true, id:'fixture-mail', stderr: 'aviso' }) === confirmedAction('gmail_send',pendPt.args,{ok:true,id:'fixture-mail'},'pt-BR') + '\n\n_stderr:_\naviso');
// Pendência SEM o campo language (gravada antes desta mudança, ou restaurada do
// banco) tem que se comportar como pt-BR, não sair vazia.
t('pendência antiga cai no pt-BR', renderConfirmed({ ...pendPt, language: undefined }, { ok: true, id:'fixture-mail' }).startsWith('Envio aceito'));

const pendEn = { name: 'gmail_send', args: { to: 'ana@x.com' }, label: describe('gmail_send', { to: 'ana@x.com' }, 'en'), language: 'en' };
t('en: sucesso em inglês', renderConfirmed(pendEn, { ok: true, id:'fixture-mail' }) === confirmedAction('gmail_send',pendEn.args,{ok:true,id:'fixture-mail'},'en'));
t('en: falha em inglês', renderConfirmed(pendEn, { ok: false, error: 'quota.' }) === "❌ I couldn't finish: send an email to ana@x.com. quota.");
const pendEs = { name: 'gmail_send', args: { to: 'ana@x.com' }, label: describe('gmail_send', { to: 'ana@x.com' }, 'es'), language: 'es' };
t('es: sucesso em espanhol', renderConfirmed(pendEs, { ok: true, id:'fixture-mail' }) === confirmedAction('gmail_send',pendEs.args,{ok:true,id:'fixture-mail'},'es'));
t('es: falha em espanhol', renderConfirmed(pendEs, { ok: false, error: 'quota.' }) === '❌ No pude terminar: enviar un correo a ana@x.com. quota.');
// Recusa textual é preservada; não vira sucesso genérico por describeDone.
t('texto puro preservado sem inventar sucesso/tradução', renderConfirmed(pendEn, 'Não enviado: erro.') === 'Não enviado: erro.');
// Saída de comando: o corpo vem cru da tool (é output de shell, não se
// traduz), mas a moldura em volta é traduzida.
const pendCmd = { name: 'rodar_comando', args: { comando: 'ls' }, label: 'x', language: 'en' };
t('en: stderr traduzido na moldura', renderConfirmed(pendCmd, { ok: true, saida: 'a.txt', stderr: 'warn' })
  === '✅ Command executed on the server.\n\na.txt\n\n_stderr:_\nwarn');

// 7) O aviso de endereço trocado entra DENTRO do label, então também precisa de
//    idioma: ele é o que faz o cartão denunciar um destinatário "corrigido" no
//    caminho, e em português passaria batido por quem não lê português.
const trocado = (lang) => avisoEnderecoTrocado('ana@x.com', 'manda pra anna@x.com', lang);
t('pt-BR: aviso igual ao de antes', trocado(null).startsWith('CONFIRA O ENDEREÇO:') && trocado('pt-BR') === trocado(null));
t('en: aviso em inglês', trocado('en').startsWith('CHECK THE ADDRESS:') && trocado('en').includes('anna@x.com') && trocado('en').includes('ana@x.com'));
t('es: aviso em espanhol', trocado('es').startsWith('REVISA LA DIRECCIÓN:') && trocado('es').includes('anna@x.com'));
// A regra estreita não muda com o idioma: sem endereço escrito pelo dono, calado.
LANGS.concat(['pt-BR']).forEach((l) => {
  t(`${l}: sem endereço escrito não avisa`, avisoEnderecoTrocado('ana@x.com', 'manda pra Ana', l) === '');
  t(`${l}: endereço claramente outro não avisa`, avisoEnderecoTrocado('ana@x.com', 'manda pra joao@y.com', l) === '');
});

// 8) Tool que NÃO está no portão (ou nem existe) cai no genérico da língua, sem
//    virar português no cartão de quem fala inglês.
t('en: tool desconhecida vira genérico em inglês', describe('tool_que_nao_existe', {}, 'en') === 'run the action "tool_que_nao_existe"');
t('es: tool desconhecida vira genérico em espanhol', describeDone('tool_que_nao_existe', {}, 'es') === 'Acción "tool_que_nao_existe" completada.');
t('pt-BR: genérico igual ao de antes',
  describe('tool_que_nao_existe', {}) === 'executar a ação "tool_que_nao_existe"'
  && describeDone('tool_que_nao_existe', {}) === 'Ação "tool_que_nao_existe" concluída.');

// 9) LIMITE DECLARADO: o resumo do CARRINHO (compras.mjs) segue em português
//    nas três línguas nesta fase. Não é esquecimento; está aqui pra ninguém
//    dizer que `fechar_pedido` está traduzido de ponta a ponta.
t('moldura existe em en e es', !!molduraEm('en') && !!molduraEm('es'));
t('moldura não existe em pt-BR (é o caminho intacto)', molduraEm('pt-BR') === null);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);

// 8) Tool que devolve frase pronta em pt-BR (criar_rotina): quem confirmou em
//    inglês ou espanhol recebia "Rotina X criada" em português (dev, 03/10).
const rotinaPt = 'Rotina "Daily quote" criada: roda todo dia às 08h (America/Sao_Paulo). Vou executar sozinho a partir da próxima vez que der o horário.';
const pendRot = lang => ({ name: 'criar_rotina', args: { titulo: 'Daily quote', hora: 8 }, label: 'x', language: lang });
t('en: rotina criada em inglês', renderConfirmed(pendRot('en'), rotinaPt).startsWith('Routine "Daily quote" created'));
t('es: rotina criada em espanhol', renderConfirmed(pendRot('es'), rotinaPt).startsWith('Rutina "Daily quote" creada'));
t('pt-BR: frase da tool intacta', renderConfirmed(pendRot('pt-BR'), rotinaPt) === rotinaPt);
