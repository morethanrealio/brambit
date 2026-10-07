import { configurationConfirmation, configurationLabel, completionLabel, retryLabel } from './discovery-conversation.mjs';
import { randomUUID } from 'node:crypto';
import { currentConfirmationSession } from './confirmation-session.mjs';
import { confirmedAction, actionEvidenceFor } from './action-evidence.mjs';
import { connectorActionReceipt, shareableLink } from './connector-action-evidence.mjs';
import { calendarRecurrence, recurrenceLabel, recurrenceOccurrences } from './calendar-recurrence.mjs';
// ── Trava de confirmação para ações que ALTERAM o mundo do usuário ──
//
// Ações de escrita/destrutivas (enviar e-mail, criar evento, subir arquivo,
// criar issue, comentar, postar) NUNCA executam direto. Quando o modelo chama
// uma dessas tools, ela apenas REGISTRA uma ação pendente e devolve um pedido
// de confirmação. A execução de verdade só acontece no turno SEGUINTE, quando o
// CÓDIGO (não o modelo) detecta uma confirmação explícita do usuário na
// mensagem crua dele. Assim a trava independe do raciocínio do modelo e resiste
// a prompt injection vindo de conteúdo lido (e-mail, documento, etc.).
//
// Na dúvida, a ação não executa. Sessões persistentes mantêm os pedidos
// independentes e pedem esclarecimento; o mapa abaixo atende o caminho legado.

// O texto de confirmação de uma COMPRA tem que trazer o valor REAL do carrinho
// montado na loja, não um número que o modelo repetiu: é esse valor que o dono
// está aprovando. Por isso a frase vem do próprio compras.mjs, montada em cima
// do carrinho guardado, e não dos args da chamada.
import { descreverCarrinho, plataformaDoCarrinho } from './compras.mjs';
// A cadência da rotina é lida pelo MESMO normalizador que a tool usa pra gravar,
// senão o cartão de confirmação descreveria um dia diferente do que vai ser salvo
// (o dono confirmaria uma coisa e a plataforma agendaria outra).
import { normalizeRoutineDays, routineDaysLabel, intervalLabel } from './scheduler.mjs';
import { routineArgsTimeLabel } from './routine-time.mjs';
// Textos do cartão em inglês e espanhol. O pt-BR abaixo fica INTACTO: as
// tabelas de en/es são consultadas antes e, quando não têm a frase, o caminho
// cai no português de sempre. Ver o cabeçalho do confirm-textos.mjs.
import { pedidoEm, feitoEm, molduraEm, copiaLabel, camposInfinity } from './confirm-textos.mjs';
import { tagIdioma, IDIOMA_PADRAO } from './locale.mjs';
import { PORTAO_TEXTOS, PORTAO_IRREVERSIVEIS, portaoTexto } from './confirm-textos-portao.mjs';
import { marca } from './marca.mjs';

const pending = new Map(); // Legacy callers/tests only. threadId -> { id, name, label, run, args, at, language, messageRefs }

const idiomaDaThread = new Map(); // threadId -> 'pt-BR' | 'en' | 'es'

// Idioma do dono desta thread. Guardado por thread, e não passado por
// parâmetro, pelo mesmo motivo do setOwnerText: `addGated` é chamado em ~20
// pontos do server.mjs, quase todos só com (registry, tools, thread.id), e
// enfiar o idioma em cada um deles é justamente o tipo de mudança onde um
// esquecimento passa em silêncio — o cartão sairia em português pra um usuário
// só naquele caminho, sem erro nenhum aparecendo.
export function setThreadLanguage(threadId, language) {
  if (!threadId) return;
  const k = String(threadId);
  idiomaDaThread.delete(k); // reinsere no fim: o Map vira fila de descarte por idade
  idiomaDaThread.set(k, tagIdioma(language));
  if (idiomaDaThread.size > 500) idiomaDaThread.delete(idiomaDaThread.keys().next().value);
}

// Idioma pra usar no cartão. Sem registro, cai no padrão, que é o pt-BR de
// hoje: uma thread cujo idioma não foi anotado se comporta exatamente como
// antes desta mudança.
function idiomaDoCartao(threadId) {
  return idiomaDaThread.get(String(threadId)) || IDIOMA_PADRAO;
}

// Como o cartão de confirmação descreve o canal pedido. "app" (= sem empurrar em
// canal nenhum) precisa virar frase: "entregar no app" não deixa claro pro dono
// que é justamente o pedido de PARAR de receber no WhatsApp/Telegram/e-mail.
function canalLabel(canal, { verbo = 'entregar', detalhe = true } = {}) {
  const c = String(canal || '').toLowerCase().trim();
  if (!c) return '';
  if (['app', 'none', 'nenhum', 'so app', 'só app'].includes(c)) {
    return `${verbo} só no app${detalhe ? ' (sem WhatsApp, Telegram nem e-mail)' : ''}`;
  }
  return `${verbo} no ${canal}`;
}

// Texto da cadência a partir dos args da tool (criar_rotina/editar_rotina).
// Devolve '' quando a chamada não mexe em cadência (edição só de horário, p.ex.).
function cadenciaLabel(args = {}) {
  const cad = normalizeRoutineDays(args);
  if (cad.error || !cad.days) return '';
  return routineDaysLabel(cad.days);
}

// Cadência COMPLETA da rotina pro cartão ("todo domingo às 18h", "a cada 30 min
// até ..."). Existe porque a rotina tem dois modos e o cartão só sabia descrever
// um: no modo INTERVALO não há hora nem dia, e a frase saía "roda todo dia às
// 0?h", ou seja, o dono confirmava uma rotina que não era a que ia ser criada.
function cadenciaFrase(args = {}) {
  const n = Number(args.repetir_cada_min);
  if (Number.isFinite(n) && n > 0) {
    const ate = args.repetir_ate ? ` até ${args.repetir_ate}` : ' (sem data pra parar)';
    return `a cada ${intervalLabel(n)}${ate}`;
  }
  const hora = routineArgsTimeLabel(args) || '07h (padrão)';
  return `${cadenciaLabel(args) || 'todo dia'} às ${hora}`;
}

// Tools que exigem confirmação humana explícita antes de executar.
export const GATED_TOOLS = new Set([
  'jornada_configurar', 'jornada_editar_nota', 'jornada_concluir', 'jornada_refazer_devolutiva',
  'gerenciar_tarefa_de_app',
  'gmail_send',
  'hotmail_send',
  'gmail_label_delete',
  'gmail_filter_create',
  'gmail_filter_delete',
  'calendar_create',
  'calendar_update',
  'calendar_delete',
  'outlook_calendar_create',
  'outlook_calendar_update',
  'outlook_calendar_delete',
  'drive_upload',
  'drive_upload_arquivo',
  'enviar_para_drive',
  'onedrive_upload',
  'onedrive_upload_arquivo',
  // Também escrevem no Drive da pessoa, e o export por cima de um PDF de mesmo
  // nome substitui o conteúdo do que já estava lá. Ficavam de fora só porque a
  // description pedia "confirme antes", o que é pedido ao modelo, não portão.
  'docs_create',
  'drive_export_pdf',
  'github_create_issue',
  'github_comment_issue',
  'slack_post_message',
  // Publica no perfil PÚBLICO da pessoa, no nome dela. Estava de fora: a única
  // trava era uma frase na description pedindo pro modelo confirmar, o que é
  // pedido, não portão.
  'linkedin_post',
  'confirmar_com_agente',
  'responder_decisao',
  'rodar_no_servidor',
  'editar_arquivo',
  'escrever_arquivo',
  'rodar_comando',
  'git_commit',
  'git_push',
  'git_branch',
  'git_checkout',
  'publicar_sistema',
  'apagar_sistema',
  'replicar_sistema',
  'voltar_versao',
  'remover_arquivo_do_app',
  'remover_segredo',
  'criar_rotina',
  'editar_rotina',
  'convidar_colaborador',
  'convidar_para_espaco',
  'instalar_skill',
  'compartilhar_skill',
  'rodar_skill',
  'notion_create_page',
  'notion_append',
  'splitwise_add_expense',
  'infinity_criar_item',
  'infinity_editar_item',
  'infinity_comentar',
  // Embora receber dinheiro não debite saldo, esta tool pode CADASTRAR uma
  // chave Pix real e criar um QR de cobrança. Isso é uma ação financeira, não
  // uma consulta: nunca pode rodar só porque o modelo interpretou uma pergunta
  // como pedido de execução.
  'asaas_receber_pix',
  'asaas_pagar_conta',
  'asaas_cancelar_pagamento_conta',
  'asaas_transferir_pix',
  'asaas_enviar_comprovante_email',
  'salvar_credencial',
  'fechar_pedido',
  'criar_conta_brambs',
  'canva_criar',
  'canva_editar',
  // Audit 28/09 ("anything that writes, edits, deletes or sends a message must
  // have no gaps"): these wrote, deleted or talked to third parties on the
  // model's decision alone. Phrases in confirm-textos-portao.mjs.
  ...Object.keys(PORTAO_TEXTOS),
]);

// IRREVERSIBLE actions, or ones that reach third parties: a 👍 (reaction) is NOT
// enough, they need TEXT confirmation ("pode"). Other gated ones can be
// confirmed with a reaction. (Decided 20/07: thumbs-up confirms the common
// ones, except irreversible ones: sending e-mail, deleting, posting, shell.)
export const IRREVERSIBLE_TOOLS = new Set([
  'jornada_concluir',
  'jornada_refazer_devolutiva',
  'jornada_editar_nota',
  'gerenciar_tarefa_de_app',
  'gmail_send',
  'hotmail_send',
  'calendar_delete',
  'outlook_calendar_delete',
  'apagar_sistema',
  'remover_segredo',
  'github_create_issue',
  'github_comment_issue',
  'slack_post_message',
  // Post público no nome da pessoa, indexado por buscador. Apagar depois não
  // desfaz quem já viu: confirmação por texto, joinha não basta.
  'linkedin_post',
  'confirmar_com_agente',
  'responder_decisao',
  'rodar_comando',
  'rodar_no_servidor',
  'git_push',
  'splitwise_add_expense',
  // Comentário no Infinity fica visível pra equipe inteira do board.
  'infinity_comentar',
  // Toda ação financeira exige confirmação por TEXTO, inclusive gerar uma
  // chave/QR para receber dinheiro. Reação e automação não substituem o aceite.
  'asaas_receber_pix',
  'asaas_pagar_conta',
  'asaas_cancelar_pagamento_conta',
  'asaas_transferir_pix',
  'asaas_enviar_comprovante_email',
  // Cria um pedido de verdade, no nome do dono, numa loja de verdade. Dinheiro
  // sai. Um 👍 não fecha compra: tem que ser confirmação por texto.
  'fechar_pedido',
  // Abre uma conta de pagamento REAL numa instituição financeira, no nome e com
  // o CPF/CNPJ do dono. Não dá pra "desabrir", e os dados vão pra análise
  // cadastral de terceiro: exige confirmação por texto, nunca joinha.
  'criar_conta_brambs',
  ...PORTAO_IRREVERSIVEIS,
]);

// Uma ação gated pode ser confirmada por REACTION (👍) só se NÃO for irreversível.
export function isReactionConfirmable(name) {
  return GATED_TOOLS.has(name) && !IRREVERSIBLE_TOOLS.has(name);
}

// O cartão entregue é do mesmo pedido que o gate guardou. O modelo não pode
// trocar o alvo na redação nem oferecer 👍 quando a ação exige aceite por texto.
function confirmationCard(name, label, language, numbered = false) {
  if (numbered) return label;
  if (name === 'jornada_configurar') return label;
  const reaction = isReactionConfirmable(name);
  const lang = tagIdioma(language || IDIOMA_PADRAO);
  if (lang === 'en') return `${label}\n\nTo confirm, reply “go ahead”${reaction ? ' or react with 👍' : ' in text'}.`;
  if (lang === 'es') return `${label}\n\nPara confirmar, responde “adelante”${reaction ? ' o reacciona con 👍' : ' por texto'}.`;
  return `${label}\n\nPara confirmar, responda “pode”${reaction ? ' ou reaja com 👍' : ' por texto'}.`;
}

// ── Destinatário de e-mail: o que o dono ESCREVEU vs o que vai ser enviado ──
//
// O portão de confirmação só protege de verdade se o cartão mostrar a ação REAL.
// Quando o endereço sai da chamada diferente do que a pessoa digitou (uma letra
// trocada, um domínio "arrumado"), o cartão exibia o endereço já alterado como se
// fosse o dela: confirmar não tinha como pegar o erro, e o e-mail ia pro lugar
// errado com o "pode" do dono. Aqui o cartão passa a dizer a diferença.
const MAIL_TOOLS = new Set(['gmail_send', 'hotmail_send', 'asaas_enviar_comprovante_email']);
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const textoDoDono = new Map(); // threadId -> texto cru das últimas mensagens dele
const textoAtualDoDono = new Map(); // threadId -> somente o pedido deste turno

// Texto que o DONO escreveu nesta thread (turno atual + histórico recente).
// Guardado por thread porque `describe` só recebe os args da tool, e a conversa
// é justamente o lado que falta pra saber se o endereço foi alterado.
export function setOwnerText(threadId, texto, atual = null) {
  if (!threadId) return;
  const k = String(threadId);
  textoDoDono.delete(k); // reinsere no fim: o Map vira fila de descarte por idade
  textoDoDono.set(k, String(texto || '').slice(-20000));
  textoAtualDoDono.delete(k);
  textoAtualDoDono.set(k, String(atual == null ? texto : atual).slice(-4000));
  if (textoDoDono.size > 500) {
    const antigo = textoDoDono.keys().next().value;
    textoDoDono.delete(antigo);
    textoAtualDoDono.delete(antigo);
  }
}

function enderecos(s) {
  return [...new Set(String(s || '').toLowerCase().match(RE_EMAIL) || [])];
}

// Distância de edição (Levenshtein). Uma letra trocada/faltando = 1.
function distancia(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Avisa quando o destinatário não é igual a um endereço que o dono escreveu, mas
// é QUASE (até 2 letras de diferença) — a assinatura de um endereço "corrigido"
// no caminho. Deliberadamente estreito, pra não virar ruído em cima de envio
// legítimo: fica calado quando o dono não escreveu endereço nenhum (veio dos
// contatos/do histórico, uso normal) e quando o endereço é claramente outro
// (destinatário diferente de propósito).
export function avisoEnderecoTrocado(destinos, texto, language = null) {
  const escritos = enderecos(texto);
  if (!escritos.length) return '';
  const lang = language ? tagIdioma(language) : IDIOMA_PADRAO;
  const avisos = [];
  for (const alvo of enderecos(destinos)) {
    if (escritos.includes(alvo)) continue;
    let melhor = null, dist = Infinity;
    for (const e of escritos) {
      const d = distancia(alvo, e);
      if (d < dist) { dist = d; melhor = e; }
    }
    if (!melhor || dist > 2) continue;
    if (lang === 'en') avisos.push(`he wrote "${melhor}" and this message is going to "${alvo}"`);
    else if (lang === 'es') avisos.push(`él escribió "${melhor}" y este envío va a "${alvo}"`);
    else avisos.push(`ele escreveu "${melhor}" e este envio vai para "${alvo}"`);
  }
  if (!avisos.length) return '';
  if (lang === 'en') return `CHECK THE ADDRESS: ${avisos.join('; ')}`;
  if (lang === 'es') return `REVISA LA DIRECCIÓN: ${avisos.join('; ')}`;
  // Frase FACTUAL, nunca instrução pro modelo: o label é impresso cru pro
  // usuário em alguns caminhos (ação irreversível, erro na execução), então ele
  // tem que ler bem tanto pra pessoa quanto pro modelo. Sendo um alerta suave,
  // um falso positivo (dois endereços parecidos de pessoas diferentes) custa
  // uma conferida, não um susto.
  return `CONFIRA O ENDEREÇO: ${avisos.join('; ')}`;
}

// Resumo legível da ação, pro agente mostrar ao usuário antes de confirmar.
//
// `language` é opcional: sem ele, ou em pt-BR, o caminho é o de sempre (o
// switch em português abaixo). Em en/es tenta a tabela traduzida primeiro e,
// se aquela tool ainda não tem frase na língua, cai no português em vez de
// devolver vazio — num cartão que autoriza gastar dinheiro, texto faltando é
// pior que texto na língua errada.
export function describe(name, args = {}, language = null) {
  if (['calendar_create', 'outlook_calendar_create'].includes(name) && args.recorrencia !== undefined) {
    const { recorrencia, ...once } = args;
    const start=args.start || args.inicio, tz=args.timezone || args.fuso;
    const label=/^en/.test(language || '')?'Next occurrences':/^es/.test(language || '')?'Próximas ocurrencias':'Próximas ocorrências';
    return `${describe(name, once, language)} ${recurrenceLabel(recorrencia,start,tz,language)} ${label}: ${recurrenceOccurrences(recorrencia,start,tz).map(o=>o.local.replace('T',' ')).join('; ')}.`;
  }
  const lang = language ? tagIdioma(language) : IDIOMA_PADRAO;
  if (lang !== IDIOMA_PADRAO) {
    const t = pedidoEm(lang, name, args);
    if (t) return t;
  }
  { const t = portaoTexto(IDIOMA_PADRAO, name, args, 0); if (t) return t; }
  switch (name) {
    case 'jornada_configurar': return configurationLabel(args);
    case 'jornada_concluir': return completionLabel();
    case 'jornada_refazer_devolutiva': return retryLabel();
    case 'jornada_editar_nota': return args.action === 'delete' ? 'apagar a nota temporária selecionada, sem apagar o histórico do chat' : `corrigir a nota temporária selecionada para: ${args.text || ''}`;
    case 'gmail_send':
      return `enviar um e-mail para ${args.to || '(destinatário?)'}${args.subject ? ` com o assunto "${args.subject}"` : ''}${copiaLabel(args.cc)}`;
    case 'hotmail_send':
      return `enviar um e-mail (Hotmail/Outlook) para ${args.to || '(destinatário?)'}${args.subject ? ` com o assunto "${args.subject}"` : ''}${copiaLabel(args.cc)}`;
    case 'gmail_label_delete':
      return `apagar o marcador "${args.marcador || '(?)'}" do seu Gmail (os e-mails ficam, só perdem o marcador)`;
    case 'gmail_filter_create': {
      const crit = [args.de && `de ${args.de}`, args.para && `para ${args.para}`, args.assunto && `assunto "${args.assunto}"`, args.contem && `contendo "${args.contem}"`, args.tem_anexo && 'com anexo'].filter(Boolean).join(', ');
      const act = [args.marcador && `marcador "${args.marcador}"`, args.pular_caixa_entrada && 'pular a caixa de entrada', args.marcar_lido && 'marcar lido', args.marcar_importante && 'marcar importante'].filter(Boolean).join(', ');
      return `criar uma regra de roteamento no Gmail: e-mails ${crit || '(critério?)'} → ${act || '(ação?)'}`;
    }
    case 'gmail_filter_delete':
      return 'apagar essa regra de roteamento (filtro) do seu Gmail';
    case 'calendar_create':
      return `criar o evento "${args.summary || args.title || '(sem título)'}"${args.start ? ` em ${args.start}` : ''}`;
    case 'calendar_update': {
      const parts = [];
      if (args.title != null) parts.push(`título para "${args.title}"`);
      if (args.start != null) parts.push(`horário para ${formatWhen(args.start)}`);
      if (args.location != null) parts.push(`local para "${args.location}"`);
      if (args.description != null) parts.push('a descrição');
      if (args.attendees?.length) parts.push('os convidados');
      return `editar o evento${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'calendar_delete':
      return 'apagar esse evento da sua agenda';
    case 'outlook_calendar_create':
      return `criar o evento "${args.titulo || '(sem título)'}" na agenda do Outlook${args.inicio ? ` em ${formatWhen(args.inicio)}` : ''}`;
    case 'outlook_calendar_update': {
      const parts = [];
      if (args.titulo != null) parts.push(`título para "${args.titulo}"`);
      if (args.inicio != null) parts.push(`horário para ${formatWhen(args.inicio)}`);
      if (args.local != null) parts.push(`local para "${args.local}"`);
      if (args.descricao != null) parts.push('a descrição');
      if (args.convidados != null) parts.push('os convidados');
      return `editar o evento na agenda do Outlook${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'outlook_calendar_delete':
      return 'apagar esse evento da agenda do Outlook';
    case 'drive_upload':
      return `subir o arquivo "${args.name || args.filename || '(sem nome)'}" no Drive`;
    case 'drive_upload_arquivo':
      return `${args.overwrite === true ? 'atualizar o arquivo existente' : 'salvar o arquivo'} "${args.nome || '(sem nome)'}" no Drive${args.overwrite === true ? ', preservando o mesmo link' : ''}`;
    case 'enviar_para_drive':
      return `${args.overwrite === true ? 'atualizar o arquivo existente' : 'salvar o arquivo'}${args.nome ? ` "${args.nome}"` : ''} no seu Google Drive${args.overwrite === true ? ', preservando o mesmo link' : ''}`;
    case 'docs_create':
      return `${args.overwrite === true ? 'atualizar no mesmo link' : 'criar no seu Drive'} o Google Doc "${args.name || '(sem nome)'}"`;
    case 'drive_export_pdf':
      return `gerar um PDF desse arquivo do Google e salvar no seu Drive${args.name ? ` como "${String(args.name).replace(/\.pdf$/i, '')}.pdf"` : ''}`;
    case 'onedrive_upload':
    case 'onedrive_upload_arquivo':
      return `subir o arquivo "${args.nome || '(sem nome)'}" no seu OneDrive`;
    case 'github_create_issue':
      return `criar uma issue no GitHub${args.repo ? ` em ${args.repo}` : ''}: "${args.title || ''}"`;
    case 'github_comment_issue':
      return `comentar na issue ${args.repo || ''}#${args.number ?? args.issue ?? ''}`;
    case 'slack_post_message':
      return `postar uma mensagem no Slack${args.channel ? ` (canal ${args.channel})` : ''}`;
    case 'linkedin_post':
      return `publicar no seu LinkedIn (${args.visibility === 'CONNECTIONS' ? 'conexões' : 'público'})`
        + `: "${String(args.text || '').slice(0, 280)}"${args.link ? ` (com o link ${args.link})` : ''}`;
    case 'confirmar_com_agente':
      return `confirmar com o assistente de ${args.contato || '(contato?)'}: "${args.decisao || ''}"`;
    case 'responder_decisao':
      return `${args.aceito ? 'confirmar' : 'recusar'} a decisão${args.de ? ` do contato ${args.de}` : ''}${args.mensagem ? `: "${args.mensagem}"` : ''}`;
    case 'rodar_no_servidor':
      return `rodar o comando \`${args.comando || ''}\` no servidor${args.host ? ` ${args.host}` : ''}`;
    case 'editar_arquivo':
      return `editar o arquivo ${args.caminho || '(?)'}${args.host ? ` em ${args.host}` : ''} (trocar um trecho)`;
    case 'escrever_arquivo':
      return `gravar o arquivo ${args.caminho || '(?)'}${args.host ? ` em ${args.host}` : ''} (cria ou sobrescreve por inteiro)`;
    case 'rodar_comando':
      return `rodar o comando \`${args.comando || ''}\` no servidor${args.host ? ` ${args.host}` : ''}`;
    case 'git_commit':
      return `fazer um commit${args.diretorio ? ` em ${args.diretorio}` : ''} com a mensagem "${args.mensagem || ''}"${args.adicionar_tudo === false ? ' (só o que já está no stage)' : ' (git add -A antes)'}`;
    case 'git_push':
      return `dar git push${args.branch ? ` da branch ${args.branch}` : ' da branch atual'} pro remote ${args.remote || 'origin'}${args.diretorio ? ` (${args.diretorio})` : ''}`;
    case 'git_branch':
      return `criar e mudar pra branch "${args.nome || ''}"${args.base ? ` a partir de ${args.base}` : ''}${args.diretorio ? ` em ${args.diretorio}` : ''}`;
    case 'git_checkout':
      return `mudar pra "${args.ref || ''}"${args.diretorio ? ` em ${args.diretorio}` : ''} (git checkout)`;
    case 'gerenciar_tarefa_de_app':
      return args.acao === 'cancelar' ? `cancelar a tarefa de ${args.app || 'app'}, preservando o rascunho` : `atualizar o escopo de ${args.app || 'app'} para ${args.modo==='edicao'?'edição do rascunho':'revisão sem edição'}: ${String(args.objetivo||'').replace(/[<>\r\n]/g,' ').slice(0,2000)}. Preserva o progresso e não publica; a execução posterior usa os créditos da conta`;
    case 'publicar_sistema':
      return args.dono
        ? `publicar uma nova versão do sistema "${args.nome_do_sistema || '(sem nome)'}" de ${args.dono} (colaboração)`
        : `publicar o sistema "${args.nome_do_sistema || '(sem nome)'}" (${args.runtime || '?'}) no seu subdomínio`;
    case 'criar_rotina':
      return `criar a rotina "${args.titulo || '(sem título)'}" que roda ${cadenciaFrase(args)}${args.canal ? `, ${canalLabel(args.canal)}` : ''}`;
    case 'editar_rotina': {
      const partes = [];
      if(args.ativa!==undefined)partes.push(args.ativa?'retomar':'pausar');
      if (args.novo_titulo) partes.push(`renomear pra "${args.novo_titulo}"`);
      if (args.canal) partes.push(canalLabel(args.canal));
      const hora = routineArgsTimeLabel(args);
      if (hora) partes.push(hora.startsWith(':') ? `no minuto ${hora}` : `às ${hora}`);
      const cad = cadenciaLabel(args);
      if (cad) partes.push(cad);
      if (args.o_que_fazer) partes.push('mudar o que ela faz');
      if (args.testar_agora === true) partes.push('aplicar as alterações e testar agora, com entrega no canal configurado');
      // A rotina pode vir identificada pelo CÓDIGO (#xxxx) em vez do título, quando
      // o dono tem duas com o mesmo nome; nesse caso é o código que vai na pergunta.
      const alvo = args.titulo ? `"${args.titulo}"` : args.id ? `#${String(args.id).replace(/^#/, '')}` : '"(sem título)"';
      return `alterar a rotina ${alvo}${partes.length ? ` (${partes.join(', ')})` : ''} — a rotina atual continua valendo até você confirmar`;
    }
    case 'convidar_colaborador':
      return `dar a ${args.contato || '(contato?)'} acesso de COLABORAÇÃO ao seu sistema "${args.nome_do_sistema || '(sem nome)'}" (ele passa a editar o código e operar os MESMOS dados)`;
    case 'convidar_para_espaco':
      return `convidar ${args.contato || '(contato?)'} pro seu Space "${args.espaco || '(sem nome)'}" (ele passa a ver e anotar no dado vivo do Space)`;
    case 'instalar_skill':
      return `instalar a Skill "${args.skill || '(sem nome)'}"${args.de ? ` de ${args.de}` : ''} neste assistente (ele passa a carregar esse comportamento)`;
    case 'compartilhar_skill':
      return `compartilhar sua Skill "${args.skill || '(sem nome)'}" com ${args.contato || '(contato?)'} (ele poderá instalá-la no assistente dele)`;
    case 'rodar_skill':
      return `rodar o script da sua Skill "${args.skill || '(sem nome)'}" no ambiente isolado (sandbox)${args.argumento ? ` com o argumento "${args.argumento}"` : ''}`;
    // Canva: a confirmação mostra o OBJETIVO na íntegra, porque é ele que o
    // sub-agente vai executar. Resumir aqui esconderia do dono exatamente o
    // texto que autoriza a ação.
    case 'canva_criar':
      return `criar isto no seu Canva: ${args.objetivo || '(sem objetivo)'}`;
    case 'canva_editar':
      return `alterar um design no seu Canva: ${args.objetivo || '(sem objetivo)'}`;
    case 'notion_create_page':
      return `criar a página "${args.titulo || '(sem título)'}" no seu Notion`;
    case 'notion_append':
      return 'acrescentar esse texto a uma página do seu Notion';
    case 'infinity_criar_item':
      return `criar um item novo no Infinity (board ${args.board_id || '?'}, pasta ${args.folder_id || '?'})${camposInfinity(args.campos) ? ` com ${camposInfinity(args.campos)}` : ''}`;
    case 'infinity_editar_item':
      return `alterar o item ${args.item_id || '?'} no Infinity${camposInfinity(args.campos) ? `: ${camposInfinity(args.campos)}` : ''}${args.folder_id ? ` (movendo para a pasta ${args.folder_id})` : ''}`;
    case 'infinity_comentar':
      return `publicar este comentário no item ${args.item_id || '?'} do Infinity, visível para todos do board: "${args.texto || ''}"`;
    case 'splitwise_add_expense':
      return `lançar no Splitwise a despesa "${args.descricao || '(sem descrição)'}" de ${args.moeda || 'BRL'} ${args.valor ?? '?'}, dividida igualmente no grupo`;
    case 'asaas_receber_pix':
      return args.valor != null
        ? `GERAR um Pix copia-e-cola de R$ ${args.valor} para receber dinheiro na sua conta Asaas. Se a conta ainda não tiver uma chave Pix ativa, também será criada uma chave aleatória. Antes de confirmar: quem usar a chave verá seu nome completo e seu CPF mascarado para conferir o destinatário`
        : 'PREPARAR sua conta Asaas para receber Pix e mostrar o copia-e-cola sem valor fixo. Se a conta ainda não tiver uma chave Pix ativa, também será criada uma chave aleatória. Antes de confirmar: quem usar a chave verá seu nome completo e seu CPF mascarado para conferir o destinatário';
    case 'asaas_pagar_conta':
      return `PAGAR pela sua conta Asaas ${args.valor != null ? `R$ ${args.valor}` : 'o valor do próprio boleto'} (boleto/conta, linha digitável ${args.linha_digitavel || args.codigo_de_barras || '(?)'})${args.agendar_para ? `, agendado para ${args.agendar_para}` : ''} — é dinheiro de verdade e não dá pra desfazer`;
    case 'asaas_cancelar_pagamento_conta':
      return `CANCELAR pela sua conta Asaas o pagamento de conta ${args.id || '(id não informado)'} — o cancelamento é irreversível e, quando confirmado pela Asaas, impede a execução do pagamento`;
    case 'asaas_transferir_pix':
      return `TRANSFERIR R$ ${args.valor ?? '?'} via PIX pela sua conta Asaas para a chave ${args.chave_pix || '(?)'} (${args.tipo_chave || '?'})${args.agendar_para ? `, agendado para ${args.agendar_para}` : ''} — é dinheiro de verdade e não dá pra desfazer`;
    case 'asaas_enviar_comprovante_email':
      return `enviar para ${args.para || '(destinatário?)'} o comprovante oficial da operação ${args.id || '(?)'} na Asaas`;
    case 'salvar_credencial':
      return `guardar sua API key de ${args.servico || '(serviço?)'} no Cofre de credenciais (fica cifrada; não aparece no chat)`;
    // O dono precisa ver exatamente com que dados a conta vai nascer: é o
    // CPF/CNPJ dele indo pra uma análise cadastral que não dá pra desfazer.
    case 'criar_conta_brambs':
      return [
        `ABRIR SUA CONTA ${marca().nome.toUpperCase()} de verdade, no seu nome:`,
        `• titular: ${args.nome || '(?)'} · ${args.cpf_cnpj || '(?)'}`,
        `• contato: ${args.email || '(?)'} · ${args.celular || '(?)'}`,
        `• endereço: ${args.endereco || '(?)'}, ${args.numero || '(?)'}${args.complemento ? ` ${args.complemento}` : ''} · ${args.bairro || '(?)'} · CEP ${args.cep || '(?)'}`,
        `• renda/faturamento informado: R$ ${args.renda_mensal ?? '(?)'}`,
        '',
        // This is THE place for the mandatory disclosure: the account is issued
        // by the partner payment institution. It's a regulatory requirement,
        // stated ONCE, on the screen where the owner authorizes. Elsewhere in
        // the flow it's just the managed payment account.
        'Depois de abrir, faltam 2 fotos (documento e selfie), que você manda aqui mesmo nesta conversa, e uma análise de até 48h. Abrir não dá pra desfazer por aqui.',
        `A conta é emitida pela *Asaas*, instituição de pagamento parceira do ${marca().nome}.`,
      ].join('\n');
    case 'fechar_pedido': {
      const resumo = descreverCarrinho(args.carrinho_id);
      // Sem carrinho não dá pra dizer o valor, e sem valor não existe aprovação
      // informada: o texto tem que deixar isso explícito em vez de inventar.
      if (!resumo) return 'FECHAR UM PEDIDO DE VERDADE na loja (mas o carrinho não existe mais, então precisa ser montado de novo antes)';
      // Loja fora da VTEX não me deixa fechar: o pagamento é na tela dela. Pedir
      // autorização pra "criar pedido real" ali seria prometer o que não acontece.
      if (plataformaDoCarrinho(args.carrinho_id) !== 'vtex') {
        return `abrir o checkout da loja com esse carrinho pronto (${resumo}). Nessa loja quem finaliza o pagamento é você, na tela dela; eu não crio o pedido nem cobro nada`;
      }
      return `FECHAR O PEDIDO DE VERDADE: ${resumo}. Isso cria um pedido real no seu nome e gera a cobrança; não dá pra desfazer por aqui`;
    }
    case 'apagar_sistema':
      // O detalhe do que existe dentro do app (nº de registros) é acrescentado
      // pelo `preflight` da tool, que consulta o host — aqui só temos os args.
      return `apagar DE VEZ o sistema "${args.nome_do_sistema || '(sem nome)'}": container, código, histórico de versões E os dados que o app guardou, incluindo segredos do cofre e acessos de colaboradores. Não tem backup nem como voltar`;
    case 'replicar_sistema':
      return `replicar o app público "${args.origem || '(origem?)'}" no seu subdomínio${args.novo_nome ? ` como "${args.novo_nome}"` : ''}`;
    case 'voltar_versao':
      return `voltar o sistema "${args.nome_do_sistema || '(sem nome)'}" para a versão ${args.versao || '(?)'} (o código volta; os dados são preservados)`;
    case 'remover_arquivo_do_app':
      return `remover o arquivo ${args.caminho || '(?)'} do rascunho do app "${args.nome_do_sistema || '(sem nome)'}" (não mexe no app no ar; dá pra voltar por versão)`;
    case 'remover_segredo':
      return `remover o segredo "${args.chave || '(?)'}" do sistema "${args.nome_do_sistema || '(sem nome)'}" (o app reinicia sem essa variável; não dá pra recuperar o valor)`;
    default:
      // Tool no portão sem frase própria em nenhuma língua: aqui o pt-BR também
      // é genérico, então traduzir o genérico não esconde informação nenhuma.
      return lang === IDIOMA_PADRAO ? `executar a ação "${name}"` : molduraEm(lang).acaoPedido(name);
  }
}

// Formata uma data/hora ISO num texto curto pt-BR (ou devolve o original).
// IMPORTANTE: mostra o horário de PAREDE exatamente como veio no ISO (sem
// converter de fuso). Ex: "2026-07-09T11:30:00+02:00" -> "09/07/2026, 11:30".
// Antes convertia pra America/Sao_Paulo e distorcia o horário de quem está em
// outro fuso (ex: usuário em Basileia via "06:30" em vez de "11:30").
function formatWhen(s) {
  if (!s || typeof s !== 'string') return '';
  const str = s.trim();
  // Só data (evento de dia inteiro): "2026-07-09" -> "09/07/2026".
  const dOnly = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dOnly) return `${dOnly[3]}/${dOnly[2]}/${dOnly[1]}`;
  // Data + hora: extrai os tokens de parede literais, sem conversão de fuso.
  const dt = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dt) return `${dt[3]}/${dt[2]}/${dt[1]}, ${dt[4]}:${dt[5]}`;
  // Fallback: formato inesperado.
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return str; }
}

// Frase no passado, legível, pro usuário ver o que FOI feito (sem JSON cru).
//
// Este é o texto MAIS crítico do arquivo pra quem não fala português: ao
// contrário do `describe`, que o modelo reescreve ao mostrar o cartão, esta
// frase é impressa DIRETO pro usuário pelo renderConfirmed. Sem tradução, quem
// pediu inglês confirma em inglês e recebe "E-mail enviado para ..." em
// português.
export function describeDone(name, args = {}, language = null) {
  if (name === 'jornada_concluir' && (!language || tagIdioma(language) === IDIOMA_PADRAO)) return `Jornada concluída. Estou preparando suas sugestões de uso do ${marca().nome} e aviso aqui quando estiverem prontas.`;
  if (name === 'jornada_refazer_devolutiva' && (!language || tagIdioma(language) === IDIOMA_PADRAO)) return 'Estou preparando sua devolutiva novamente. Aviso aqui quando estiver pronta.';
  if (['calendar_create', 'outlook_calendar_create'].includes(name) && args.recorrencia !== undefined) {
    const { recorrencia, ...once } = args;
    return `${describeDone(name, once, language)} ${recurrenceLabel(recorrencia, args.start || args.inicio, args.timezone || args.fuso, language)}`;
  }
  const lang = language ? tagIdioma(language) : IDIOMA_PADRAO;
  if (lang !== IDIOMA_PADRAO) {
    const t = feitoEm(lang, name, args);
    if (t) return t;
  }
  { const t = portaoTexto(IDIOMA_PADRAO, name, args, 1); if (t) return t; }
  switch (name) {
    case 'gmail_send':
      return `E-mail enviado para ${args.to || 'o destinatário'}${args.subject ? ` com o assunto "${args.subject}"` : ''}${copiaLabel(args.cc)}.`;
    case 'hotmail_send':
      return `E-mail (Hotmail/Outlook) enviado para ${args.to || 'o destinatário'}${args.subject ? ` com o assunto "${args.subject}"` : ''}${copiaLabel(args.cc)}.`;
    case 'gmail_label_delete':
      return `Marcador "${args.marcador || ''}" apagado do seu Gmail.`;
    case 'gmail_filter_create':
      return 'Regra de roteamento criada no seu Gmail (vale pros próximos e-mails).';
    case 'gmail_filter_delete':
      return 'Regra de roteamento apagada do seu Gmail.';
    case 'calendar_create': {
      const when = formatWhen(args.start);
      const tz = args.timezone ? ` (${args.timezone})` : '';
      return `Evento "${args.summary || args.title || 'sem título'}" criado na sua agenda${when ? ` para ${when}${tz}` : ''}.`;
    }
    case 'calendar_update': {
      const parts = [];
      if (args.title != null) parts.push(`título "${args.title}"`);
      if (args.start != null) parts.push(`horário ${formatWhen(args.start)}${args.timezone ? ` (${args.timezone})` : ''}`);
      if (args.location != null) parts.push(`local "${args.location}"`);
      if (args.description != null) parts.push('descrição');
      if (args.attendees?.length) parts.push('convidados');
      return `Evento atualizado${parts.length ? `: ${parts.join(', ')}` : ''}.`;
    }
    case 'calendar_delete':
      return 'Evento apagado da sua agenda.';
    case 'outlook_calendar_create': {
      const when = formatWhen(args.inicio);
      return `Evento "${args.titulo || 'sem título'}" criado na agenda do Outlook${when ? ` para ${when}` : ''}.`;
    }
    case 'outlook_calendar_update': {
      const parts = [];
      if (args.titulo != null) parts.push(`título "${args.titulo}"`);
      if (args.inicio != null) parts.push(`horário ${formatWhen(args.inicio)}`);
      if (args.local != null) parts.push(`local "${args.local}"`);
      if (args.descricao != null) parts.push('descrição');
      if (args.convidados != null) parts.push('convidados');
      return `Evento do Outlook atualizado${parts.length ? `: ${parts.join(', ')}` : ''}.`;
    }
    case 'outlook_calendar_delete':
      return 'Evento apagado da agenda do Outlook.';
    case 'drive_upload':
      return `Arquivo "${args.name || args.filename || 'sem nome'}" enviado pro seu Drive.`;
    case 'drive_upload_arquivo':
      return `Arquivo "${args.nome || 'sem nome'}" enviado pro seu Drive.`;
    case 'enviar_para_drive':
      return `Cópia${args.nome ? ` de "${args.nome}"` : ''} enviada pro seu Google Drive.`;
    case 'docs_create':
      return `Google Doc "${args.name || 'sem nome'}" criado no seu Drive.`;
    case 'drive_export_pdf':
      return 'PDF gerado e salvo no seu Drive.';
    case 'onedrive_upload':
    case 'onedrive_upload_arquivo':
      return `Arquivo "${args.nome || 'sem nome'}" enviado pro seu OneDrive.`;
    case 'github_create_issue':
      return `Issue criada${args.repo ? ` em ${args.repo}` : ''}: "${args.title || ''}".`;
    case 'github_comment_issue':
      return `Comentário publicado na issue ${args.repo || ''}#${args.number ?? args.issue ?? ''}.`;
    case 'slack_post_message':
      return `Mensagem postada no Slack${args.channel ? ` (canal ${args.channel})` : ''}.`;
    case 'linkedin_post':
      return 'Post publicado no seu LinkedIn.';
    case 'confirmar_com_agente':
      return `Decisão enviada ao assistente de ${args.contato || 'seu contato'}.`;
    case 'responder_decisao':
      return `Resposta ${args.aceito ? 'de confirmação' : 'de recusa'} enviada ao assistente do contato.`;
    case 'rodar_no_servidor':
      return `Comando executado no servidor${args.host ? ` ${args.host}` : ''}.`;
    case 'editar_arquivo':
      return `Arquivo ${args.caminho || ''} editado.`;
    case 'escrever_arquivo':
      return `Arquivo ${args.caminho || ''} gravado.`;
    case 'rodar_comando':
      return `Comando executado no servidor${args.host ? ` ${args.host}` : ''}.`;
    case 'git_commit':
      return `Commit feito${args.diretorio ? ` em ${args.diretorio}` : ''}: "${args.mensagem || ''}".`;
    case 'git_push':
      return `Push feito${args.branch ? ` da branch ${args.branch}` : ' da branch atual'} pro remote ${args.remote || 'origin'}.`;
    case 'git_branch':
      return `Branch "${args.nome || ''}" criada e ativa.`;
    case 'git_checkout':
      return `Mudei pra "${args.ref || ''}".`;
    case 'gerenciar_tarefa_de_app':
      return args.acao === 'cancelar' ? 'Tarefa cancelada; rascunho preservado.' : 'Escopo atualizado; progresso e consumo preservados. Nada foi editado, testado ou publicado nesta confirmação. Peça para continuar quando quiser iniciar.';
    case 'publicar_sistema':
      return `Sistema "${args.nome_do_sistema || ''}" publicado no seu subdomínio.`;
    case 'apagar_sistema':
      return `Sistema "${args.nome_do_sistema || ''}" apagado de vez (código, histórico, dados, segredos do cofre e acessos de colaboradores). Não dá pra recuperar.`;
    case 'replicar_sistema':
      return `App replicado no seu subdomínio${args.novo_nome ? ` como "${args.novo_nome}"` : ''}.`;
    case 'voltar_versao':
      return `Sistema "${args.nome_do_sistema || ''}" revertido para a versão ${args.versao || ''}.`;
    case 'criar_rotina':
      return `Rotina "${args.titulo || 'sem título'}" criada: roda ${cadenciaFrase(args)}${args.canal ? ` (${canalLabel(args.canal, { verbo: 'entrega', detalhe: false })})` : ''}. Vou executá-la sozinho a partir da próxima vez que der o horário.`;
    case 'editar_rotina':
      return `Rotina ${args.novo_titulo || args.titulo ? `"${args.novo_titulo || args.titulo}"` : `#${String(args.id || '').replace(/^#/, '')}`} atualizada no lugar (a versão antiga rodou normalmente até agora).`;
    case 'convidar_colaborador':
      return `${args.contato || 'O contato'} agora colabora no sistema "${args.nome_do_sistema || ''}" (edita o código e opera os mesmos dados).`;
    case 'convidar_para_espaco':
      return `${args.contato || 'O contato'} agora participa do Space "${args.espaco || ''}".`;
    case 'instalar_skill':
      return `Skill "${args.skill || ''}"${args.de ? ` de ${args.de}` : ''} instalada neste assistente.`;
    case 'compartilhar_skill':
      return `Skill "${args.skill || ''}" compartilhada com ${args.contato || 'o contato'} (ele já pode instalá-la).`;
    case 'rodar_skill':
      return `Script da Skill "${args.skill || ''}" executado no sandbox.`;
    case 'canva_criar':
      return 'Pronto no seu Canva.';
    case 'canva_editar':
      return 'Design alterado no seu Canva.';
    case 'notion_create_page':
      return `Página "${args.titulo || ''}" criada no seu Notion.`;
    case 'notion_append':
      return 'Texto acrescentado à página do seu Notion.';
    case 'infinity_criar_item':
      return 'Item criado no Infinity.';
    case 'infinity_editar_item':
      return 'Item atualizado no Infinity.';
    case 'infinity_comentar':
      return 'Comentário publicado no Infinity.';
    case 'splitwise_add_expense':
      return `Despesa "${args.descricao || ''}" (${args.moeda || 'BRL'} ${args.valor ?? ''}) lançada no Splitwise, dividida igualmente.`;
    case 'asaas_receber_pix':
      return 'Recebimento Pix preparado na sua conta Asaas.';
    case 'asaas_pagar_conta':
      return `Pagamento${args.valor != null ? ` de R$ ${args.valor}` : ''} confirmado pela Asaas${args.agendar_para ? ` (agendado para ${args.agendar_para})` : ''}.`;
    case 'asaas_cancelar_pagamento_conta':
      return 'Pagamento de conta cancelado pela Asaas. Ele não será executado.';
    case 'asaas_transferir_pix':
      return `PIX de R$ ${args.valor ?? ''} enviado pela sua conta Asaas para a chave ${args.chave_pix || ''}${args.agendar_para ? ` (agendado para ${args.agendar_para})` : ''}.`;
    case 'asaas_enviar_comprovante_email':
      return `Comprovante enviado por e-mail para ${args.para || 'o destinatário'}.`;
    case 'salvar_credencial':
      return `API key de ${args.servico || 'serviço'} guardada no Cofre (cifrada).`;
    // Só o cabeçalho: o detalhe do pedido (número, total, Pix) vem no corpo que
    // a própria tool devolve e o renderConfirmed cola aqui embaixo.
    case 'fechar_pedido':
      return 'Pedido feito na loja. Falta só o pagamento:';
    // Idem: o corpo (titular, agência/conta e o PRÓXIMO passo, um só) vem da
    // própria tool. O cabeçalho não repete "Asaas" nem anuncia lista de
    // pendência: o processo já foi explicado antes de abrir.
    case 'criar_conta_brambs':
      return `Conta ${marca().nome} aberta no seu nome.`;
    default:
      return lang === IDIOMA_PADRAO ? `Ação "${name}" concluída.` : molduraEm(lang).acaoFeita(name);
  }
}

// Monta a resposta LIMPA depois de executar uma ação confirmada. Nunca expõe o
// retorno cru da tool (JSON) ao usuário: extrai só o que importa (sucesso/erro
// e um eventual link) e redige no idioma do dono.
//
// O idioma vem de `pend.language`, gravado quando a ação foi REGISTRADA, não
// lido agora: a confirmação acontece num turno posterior, e o par
// pedido/resultado tem que sair na mesma língua mesmo que o dono troque o
// idioma no meio. Pendência antiga (gravada antes desta mudança, ou restaurada
// do banco) não tem o campo e cai no pt-BR, o comportamento de hoje.
// Tools com confirmação cuja saída é uma frase de sucesso fixa em pt-BR.
const FRASE_PRONTA_PT = new Set(['criar_rotina']);
export function renderConfirmed(pend, r) {
  const lang = pend?.language ? tagIdioma(pend.language) : IDIOMA_PADRAO;
  const m18n = lang === IDIOMA_PADRAO ? null : molduraEm(lang);
  const feito = () => describeDone(pend.name, pend.args, pend.language);
  let data = null;
  if (r && typeof r === 'object') data = r;
  else if (typeof r === 'string') {
    const t = r.trim();
    if (t[0] === '{' || t[0] === '[') { try { data = JSON.parse(t); } catch {} }
    // Texto puro não-JSON: a própria tool já devolveu algo legível.
    if (!data && t) {
      // Erros textuais continuam acionáveis. Sucesso de e-mail precisa de ID.
      if (/^(?:ERRO|Não|Nao|Error|No |I couldn't)/i.test(t)) return t;
      const recibo = confirmedAction(pend.name, pend.args, r, lang);
      if (recibo) return recibo;
      // A frase pronta da tool é pt-BR ("Rotina X criada: roda..."): quem
      // confirmou em inglês ou espanhol recebe a mesma ação no idioma dele.
      // Só onde a frase traduzida diz exatamente o mesmo fato; em tool de envio
      // o texto pode dizer "agendado" e a tradução diria "enviado".
      const traduzido = m18n && FRASE_PRONTA_PT.has(pend.name) ? feitoEm(lang, pend.name, pend.args) : null;
      return traduzido || t;
    }
  }
  const uncertain = lang === 'en' ? 'The action has no verifiable completion confirmation. I will not automatically repeat it.' : lang === 'es' ? 'La acción no tiene confirmación verificable de finalización. No la repetiré automáticamente.' : 'A ação não tem confirmação verificável de conclusão. Não vou repeti-la automaticamente.';
  if (data?.action_evidence) return confirmedAction(pend.name, pend.args, r, lang) || uncertain;
  if (!data || (data.ok !== true && data.ok !== false)) return uncertain;
  if (data.ok !== false && data.skipped) return `${uncertain}${data.aviso ? '\n' + data.aviso : ''}`;
  // PENDING conhecido é um estado verificável da instituição, não uma falha
  // incerta. Para Pix, o webhook fecha o ciclo na própria conversa. Incerteza
  // de transporte continua no caminho separado (`incerto:true`) e mantém o
  // aviso forte de não repetição.
  if (data.ok !== false && data.incerto) return `${uncertain}${data.aviso ? '\n' + data.aviso : ''}`;
  if (data.ok !== false && (data.saiu === false || data.pending || String(data.status || '').toUpperCase() === 'PENDING')) {
    if (data.aviso) return data.aviso;
    if (pend?.name === 'asaas_pagar_conta') {
      const providerDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.data_processamento_provedor || ''))
        ? String(data.data_processamento_provedor) : null;
      const confirmedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.data_processamento_confirmada || ''))
        ? String(data.data_processamento_confirmada) : null;
      const fmt = (iso) => {
        const [year, month, day] = String(iso).split('-');
        return lang === 'en' ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
      };
      if (data.data_processamento_divergente && providerDate && confirmedDate) {
        return lang === 'en'
          ? `Asaas accepted the bill payment but set processing for ${fmt(providerDate)}, instead of the confirmed date ${fmt(confirmedDate)}. It has not been paid yet. Do not repeat the request; I will update you here when its status changes.`
          : lang === 'es'
            ? `Asaas aceptó el pago, pero indicó procesamiento para el ${fmt(providerDate)}, en lugar de la fecha confirmada ${fmt(confirmedDate)}. Todavía no se ha pagado. No repitas la solicitud; te avisaré aquí cuando cambie el estado.`
            : `A Asaas aceitou o pagamento, mas informou processamento em ${fmt(providerDate)}, diferente de ${fmt(confirmedDate)} que você confirmou. Ele ainda não foi pago. Não repita o pedido; avisarei aqui quando o status mudar.`;
      }
      if (providerDate) {
        return lang === 'en'
          ? `Asaas accepted the bill payment for ${fmt(providerDate)}. It is still awaiting bank processing; I will update you here when it is complete.`
          : lang === 'es'
            ? `Asaas aceptó el pago para el ${fmt(providerDate)}. Todavía está pendiente de procesamiento bancario; te avisaré aquí cuando finalice.`
            : `A Asaas aceitou o pagamento para ${fmt(providerDate)}. Ele ainda aguarda processamento bancário; avisarei aqui quando concluir.`;
      }
      return lang === 'en'
        ? 'Asaas accepted the bill payment, but it is still awaiting bank processing. Do not repeat the request; I will update you here when it is complete.'
        : lang === 'es'
          ? 'Asaas aceptó el pago, pero todavía está pendiente de procesamiento bancario. No repitas la solicitud; te avisaré aquí cuando finalice.'
          : 'A Asaas aceitou o pagamento, mas ele ainda aguarda processamento bancário. Não repita o pedido; avisarei aqui quando concluir.';
    }
    if (pend?.name === 'asaas_transferir_pix') {
      return lang === 'en'
        ? 'The Pix is being processed. I will let you know here when it is complete.'
        : lang === 'es'
          ? 'El Pix está en proceso. Te avisaré aquí cuando finalice.'
          : 'O Pix está em processamento. Avisarei aqui quando concluir.';
    }
    return uncertain;
  }
  // Saída de comando (ex: rodar_no_servidor): mostra stdout/stderr quando houver.
  const out = data && (data.saida || data.output);
  const err = data && data.stderr;
  if (data && data.ok === false) {
    // The only path where the REQUEST text is printed raw to the user: so
    // `describe` also needs translation, even though the model usually
    // rewrites it.
    //
    // Only the request's FIRST LINE goes into the header. A one-line label (most
    // of them) is unchanged; a long label (the managed payment account's carries
    // the whole sign-up) reprinted everything here, and the person read a dump
    // instead of the failure reason. What they need is: what failed, in one
    // line, and what to do now.
    const resumo = String(pend.label || '').split('\n')[0].trim().replace(/[.:]\s*$/, '');
    const cabeca = m18n ? m18n.falhou(resumo) : `Não consegui concluir: ${resumo}.`;
    let m = `❌ ${cabeca}${data.error ? ' ' + data.error : ''}`;
    if (out) m += `\n\n${out}`;
    if (err) m += `\n\n${m18n ? m18n.stderr : '_stderr:_'}\n${err}`;
    return m;
  }
  if (pend?.name === 'asaas_receber_pix') {
    const valor = data.valor != null
      ? lang === 'en' ? ` for BRL ${Number(data.valor).toFixed(2)}` : lang === 'es' ? ` por R$ ${Number(data.valor).toFixed(2).replace('.', ',')}` : ` de R$ ${Number(data.valor).toFixed(2).replace('.', ',')}`
      : lang === 'en' ? ' with no fixed amount' : lang === 'es' ? ' sin importe fijo' : ' sem valor fixo';
    const chave = data.chave_pix ? `\n${lang === 'en' ? 'PIX key' : lang === 'es' ? 'Clave PIX' : 'Chave Pix'}: ${data.chave_pix}` : '';
    const copia = data.copia_e_cola ? `\n${lang === 'en' ? 'PIX copy-and-paste code' : lang === 'es' ? 'Código PIX copia y pega' : 'Copia-e-cola'}${valor}:\n${data.copia_e_cola}` : '';
    const estado = lang === 'en'
      ? (data.chave_criada_agora ? 'Random PIX key created after your confirmation.' : 'I used the PIX key that was already active in the account.')
      : lang === 'es'
        ? (data.chave_criada_agora ? 'Clave PIX aleatoria creada después de tu confirmación.' : 'Usé la clave PIX que ya estaba activa en la cuenta.')
        : (data.chave_criada_agora ? 'Chave Pix aleatória criada após sua confirmação.' : 'Usei a chave Pix que já estava ativa na conta.');
    const conta = data.conta_usada ? `\n${lang === 'en' ? 'Account used' : lang === 'es' ? 'Cuenta utilizada' : 'Conta usada'}: ${data.conta_usada}` : '';
    return `✅ ${estado}${conta}${chave}${copia}`;
  }
  const receiptText = confirmedAction(pend.name, pend.args, r, lang);
  const evidence = actionEvidenceFor(pend.name,pend.args,r);
  if (['calendar_create','calendar_update','calendar_delete'].includes(pend.name)
      && ['created','updated','deleted'].includes(evidence?.state)) {
    const name = pend.args?.title || pend.args?.summary || pend.binding?.event?.summary;
    if (name) {
      const verb = lang === 'en' ? {created:'Created',updated:'Updated',deleted:'Deleted'}
        : lang === 'es' ? {created:'Creé',updated:'Actualicé',deleted:'Eliminé'} : {created:'Criei',updated:'Atualizei',deleted:'Excluí'};
      const when = pend.args?.start ? formatWhen(pend.args.start) : '';
      const agenda = data.agenda || pend.binding?.calendar?.nome;
      const where = agenda === 'principal' ? (lang === 'en' ? 'primary calendar' : lang === 'es' ? 'calendario principal' : 'agenda principal') : agenda;
      const line = `${verb[evidence.state]} “${name}”${when ? ` — ${when}` : ''}${where ? ` (${where})` : ''}.`;
      return `${line}${pend.args?.recorrencia ? `\n${recurrenceLabel(pend.args.recorrencia,pend.args.start,pend.args.timezone,lang)}` : ''}${data.link ? `\n${data.link}` : ''}`;
    }
  }
  if (['enviar_para_drive','drive_upload_arquivo','docs_create','drive_upload'].includes(pend.name)
      && data?.atualizado === true && evidence?.state === 'saved_file') {
    const name = data.name || pend.args?.nome || pend.args?.name || '';
    const text = lang === 'en' ? `Updated “${name}” in the same file, keeping its link.`
      : lang === 'es' ? `Actualicé “${name}” en el mismo archivo, conservando su enlace.`
        : `Atualizei “${name}” no mesmo arquivo, preservando o link.`;
    const rawUpdated = data.link || data.url || data.webViewLink;
    const updatedLink = rawUpdated && (shareableLink(rawUpdated) || rawUpdated);
    return `${text}${updatedLink ? `\n${updatedLink}` : ''}`;
  }
  // Conector confirmado pelo serviço: a frase diz o que foi feito com os dados
  // que a pessoa aprovou (nome, valor), em vez de "Registro criado no serviço"
  // com o ID interno do grupo ou quadro (Splitwise, 28/09/2026). Parcial e
  // "aceito pelo serviço" seguem no recibo genérico, que é mais preciso.
  if (connectorActionReceipt(pend.name, {}, null)
      && ['created','updated','deleted','saved_file','commented'].includes(evidence?.state)) {
    const args = pend.name === 'splitwise_add_expense'
      ? { ...pend.args, valor: data.valor ?? pend.args?.valor, moeda: data.moeda ?? pend.args?.moeda } : pend.args;
    return `${describeDone(pend.name, args, pend.language)}${evidence.link ? `\n${evidence.link}` : ''}`;
  }
  let msg = receiptText || `✅ ${feito()}`;
  if (out) msg += `\n\n${out}`;
  if (err) msg += `\n\n${m18n ? m18n.stderr : '_stderr:_'}\n${err}`;
  if (data?.conta_usada) msg += `\n${lang === 'en' ? 'Account used' : lang === 'es' ? 'Cuenta utilizada' : 'Conta usada'}: ${data.conta_usada}`;
  const rawLink = data && (data.link || data.url || data.htmlLink || data.comprovante);
  const link = rawLink && (shareableLink(rawLink) || rawLink);
  if (link && !receiptText?.includes(link)) msg += `\n${link}`;
  // App privado: o recibo é determinístico e o modelo só repete a referência,
  // então usuário e senha precisam sair aqui ou a pessoa nunca os recebe.
  if (['publicar_sistema','replicar_sistema'].includes(pend?.name)) msg += appAccessLines(data, lang);
  return msg;
}

function appAccessLines(data, lang) {
  const c = data?.credenciais;
  const temLogin = !!(c && typeof c.usuario === 'string' && typeof c.senha === 'string' && c.usuario && c.senha);
  let out = '';
  if (temLogin) {
    out += lang === 'en'
      ? `\n\nThe app is private; the browser will ask for this login:\nUser: ${c.usuario}\nPassword: ${c.senha}\nYou can share it with anyone you want to give access to.`
      : lang === 'es'
        ? `\n\nLa app es privada; el navegador pedirá este acceso:\nUsuario: ${c.usuario}\nContraseña: ${c.senha}\nPuedes compartirlo con quien quieras dar acceso.`
        : `\n\nO app é privado; o navegador vai pedir este login:\nUsuário: ${c.usuario}\nSenha: ${c.senha}\nVocê pode passar pra quem quiser dar acesso.`;
  }
  // Portão falhou = sem credencial. Com credencial, o aviso é de registro
  // (replicar_sistema usa aviso_acesso para os dois casos).
  if (data?.aviso_acesso && !temLogin) out += lang === 'en'
    ? '\n\n⚠️ The app was published but the platform could not lock the link yet: for now anyone with it can open the app.'
    : lang === 'es'
      ? '\n\n⚠️ La app se publicó, pero la plataforma todavía no pudo proteger el enlace: por ahora cualquiera con él puede abrirla.'
      : '\n\n⚠️ O app foi publicado, mas a plataforma ainda não conseguiu trancar o link: por enquanto qualquer pessoa com ele abre o app.';
  if (temLogin && (data?.aviso_registro_acesso || data?.aviso_acesso)) out += lang === 'en'
    ? '\nSave this login now: the platform could not record it and may not be able to show it again.'
    : lang === 'es'
      ? '\nGuarda este acceso ahora: la plataforma no pudo registrarlo y quizá no pueda mostrarlo de nuevo.'
      : '\nGuarde este login agora: a plataforma não conseguiu registrá-lo e pode não conseguir mostrar de novo.';
  return out;
}

// Tools de ESCRITA/mutação (código + shell no servidor): no modo "aceitar_edicoes"
// rodam INLINE (sem a cerimônia de confirmação); no modo "plano" são recusadas (só leitura).
const CODING_WRITE = new Set(['editar_arquivo', 'escrever_arquivo', 'rodar_comando', 'rodar_no_servidor', 'git_commit', 'git_push', 'git_branch', 'git_checkout']);
// Tools que rodam comando de shell: podem ser pré-autorizadas por prefixo (allowlist).
const CMD_TOOLS = new Set(['rodar_comando', 'rodar_no_servidor']);

// Metacaracteres que o shell remoto interpreta. Com qualquer um deles no resto do
// comando, o que roda deixa de ser "o comando que o dono autorizou" e vira uma
// cadeia arbitraria ("git status && rm -rf /pasta"). Nesse caso a pre-autorizacao
// nao vale: a acao NAO e recusada, so perde o atalho e volta pro fluxo normal de
// confirmacao.
const SHELL_META = /[;&|`$(){}<>\n\r\\]/;

// Um comando casa a allowlist se for exatamente um prefixo autorizado, ou se começar
// com "<prefixo> " (fronteira de palavra, pra "git" não liberar "github...") E o
// restante não trouxer metacaractere de shell.
export function cmdAllowed(comando, allowlist) {
  const c = String(comando || '').trim();
  if (!c) return false;
  return allowlist.some((p) => {
    const pf = String(p || '').trim();
    if (!pf) return false;
    if (c === pf) return true;
    if (!c.startsWith(pf + ' ')) return false;
    return !SHELL_META.test(c.slice(pf.length));
  });
}

// Envolve uma tool "perigosa". Comportamento depende do MODO de permissão do
// agente (opts.mode) e da allowlist de comandos (opts.allowlist):
//  • padrao          -> registra ação pendente e exige confirmação (default seguro).
//  • aceitar_edicoes -> tools de coding-write rodam INLINE, resultado no mesmo turno.
//  • plano           -> tools de coding-write são recusadas (nada é alterado).
//  • allowlist       -> comando pré-autorizado roda INLINE em qualquer modo.
// Tools fora do GATED_TOOLS passam intactas, exceto as de nome dinâmico que
// chegam marcadas com `requiresConfirmation: true` (ex.: conectores MCP, cujo
// nome só se conhece em tempo de execução).
export function gateTool(tool, threadId, opts = {}) {
  if (!GATED_TOOLS.has(tool.name) && tool.requiresConfirmation !== true) return tool;
  const mode = opts.mode || 'padrao';
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : [];
  return {
    // Server-only adapter for reconstruction. ToolRegistry.defs does not expose
    // this object to a model or a client.
    confirmationTool: tool,
    confirmationOptions: opts,
    name: tool.name,
    description:
      tool.description +
      ' [IMPORTANT: this is a REAL action that changes the user\'s world. CALLING this tool IS ALREADY the way to propose the action; do NOT ask for permission in text before calling it. When called, it normally does NOT execute right away: the system records the request and only executes it after the user explicitly confirms in the next turn. Describe alongside what will be done. (Exception: if the user turned on the "aceitar edições" (accept edits) mode or pre-authorized the command, it runs directly and you get the result right away.)]',
    parameters: tool.parameters,
    async run(args) {
      // Todo gate guarda seu próprio retrato dos argumentos, não só as tools
      // com preparo especial. O chamador pode reutilizar/mutar o objeto enquanto
      // um preflight espera; isso não pode mudar o pedido que será confirmado.
      try { args = JSON.parse(JSON.stringify(args || {})); }
      catch { return 'NÃO registrei o pedido: parâmetros inválidos. Nenhuma ação foi executada.'; }
      // Valida ANTES de criar pendência: erro nunca vira evento único nem pedido
      // de confirmação enganoso. O conector repete a validação antes do HTTP.
      if (['calendar_create', 'outlook_calendar_create'].includes(tool.name)) {
        try { calendarRecurrence(args?.recorrencia, args?.start || args?.inicio, args?.timezone || args?.fuso); }
        catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
      }

      // Modo plano: não altera nada.
      if (mode === 'plano' && CODING_WRITE.has(tool.name)) {
        return `MODO PLANO ativo: não altero nada agora. Descreva o que faria (arquivo/comando) e peça pro usuário liberar (ex: "pode aplicar" ou trocar pra o modo padrão/aceitar edições) antes de executar.`;
      }
      // Execução inline (pula a confirmação): modo aceitar_edicoes p/ coding-write,
      // ou comando pré-autorizado na allowlist.
      const inlineByMode = (mode === 'aceitar_edicoes' || mode === 'livre') && CODING_WRITE.has(tool.name);
      const inlineByAllow = CMD_TOOLS.has(tool.name) && cmdAllowed(args?.comando, allowlist);
      if (!opts.confirmationPreview && (inlineByMode || inlineByAllow)) {
        return tool.run(args);
      }
      // Algumas mutacoes sao estritamente redutoras de risco e reversiveis
      // (hoje: apenas PAUSAR uma rotina, sem mudar mais nada). A propria tool
      // declara essa excecao de forma estreita; nunca inferimos pelo nome nem
      // pelo texto do modelo. Ela ainda passa pelo preflight abaixo antes de
      // executar, para validar e resolver o alvo real.
      const inlineByPolicy = typeof tool.runWithoutConfirmation === 'function'
        && tool.runWithoutConfirmation(args) === true;
      // O caminho legado mantém uma pendência; a sessão persistente suporta várias.
      if (!opts.confirmationPreview && !currentConfirmationSession(threadId) && pending.has(threadId)) {
        return 'Já existe uma ação aguardando a confirmação do usuário nesta conversa. Trate uma de cada vez: confirme (ou cancele) a anterior antes de propor outra.';
      }
      const lang = idiomaDoCartao(threadId);
      // Algumas ferramentas precisam confrontar argumentos do modelo com a
      // intenção literal DESTE turno antes de montar a confirmação. Exemplo:
      // vencimento de boleto não autoriza o modelo a inventar um agendamento.
      if (!opts.confirmationPreview && typeof tool.normalizeConfirmationArgs === 'function') {
        let normalized, cloned;
        try {
          cloned = JSON.parse(JSON.stringify(args || {}));
          normalized = await tool.normalizeConfirmationArgs(cloned, {
            ownerText: textoAtualDoDono.get(String(threadId)) || '',
            language: lang,
          });
        } catch (e) {
          return `NÃO registrei o pedido: ${String(e?.message || 'Não consegui validar os dados da ação.')} Nenhuma ação foi executada.`;
        }
        if (normalized?.erro) return `NÃO registrei o pedido: ${String(normalized.erro)} Nenhuma ação foi executada.`;
        args = normalized?.args || normalized || cloned;
      }
      const restored = opts.restoreDescriptor && typeof tool.restoreConfirmation === 'function'
        ? await tool.restoreConfirmation(args, opts.restoreDescriptor) : null;
      // Tool de nome dinâmico não tem frase no describe(): ela mesma descreve o pedido.
      let label = (typeof tool.describeConfirmation === 'function' && tool.describeConfirmation(args, lang)) || describe(tool.name, args, lang);
      let mailAddressWarning = '';
      // E-mail: se o destinatário divergir do que o dono escreveu, isso entra no
      // cartão. Sem isso o cartão exibia o endereço alterado como se fosse o dele.
      if (MAIL_TOOLS.has(tool.name)) {
        const destinatarios = tool.name === 'asaas_enviar_comprovante_email'
          ? args?.para
          : [args?.to, args?.cc].filter(Boolean).join(',');
        const aviso = avisoEnderecoTrocado(
          destinatarios,
          textoDoDono.get(String(threadId)) || '',
          lang,
        );
        if (aviso) { mailAddressWarning = aviso; label = `${label}. ${aviso}`; }
      }
      // Enriquecimento opcional: a tool pode oferecer um `preflight(args)` que
      // consulta o estado REAL antes da confirmação, pra o usuário não confirmar
      // no escuro (ex: quantos registros morrem ao apagar um app). Contrato:
      // READ-ONLY, devolve `{ aviso }`, `{ erro }` ou nada. Best-effort — se
      // falhar ou demorar, o gate continua valendo com o label básico.
      //
      // `erro` = argumento que a tool JÁ SABE que vai recusar (hora 25, dia da
      // semana que não existe). Sem isso o pedido virava cartão de confirmação
      // descrevendo o valor arredondado, o dono confirmava, e só então a tool
      // recusava: ele tinha confirmado uma coisa que nunca existiu. Voltando
      // agora, o modelo corrige no mesmo turno.
      let recusa = null;
      try {
        const extra = await (restored?.preflight || tool.preflight)?.(args);
        if (extra && extra.erro) recusa = String(extra.erro);
        else if (extra && extra.aviso) label = `${label}. ${extra.aviso}`;
      } catch (e) {
        if (opts.confirmationPreview || currentConfirmationSession(threadId)) throw Error('Não consegui conferir novamente o alvo da confirmação.');
        /* segue com o label básico */
      }
      if (recusa) return `NÃO registrei o pedido: ${recusa} Corrija o argumento e chame a tool de novo (não peça confirmação de algo que não foi registrado).`;
      if (!opts.confirmationPreview && inlineByPolicy) return tool.run(args);
      // Security binding is NOT best-effort enrichment. Trusted tools may bind
      // their target before the card; failures must never register a runnable action.
      // The bound callback stays server-side; no model-supplied capability/ID grants access.
      let confirmedRun=tool.run,confirmedArgs,preparedDescriptor=null,confirmationText=null;
      try { confirmedArgs = JSON.parse(JSON.stringify(args)); }
      catch { return 'NÃO registrei o pedido: parâmetros inválidos. Nenhuma ação foi executada.'; }
      if (restored) {
        if (typeof restored?.run !== 'function') throw Error('Não consegui restaurar o pedido.');
        confirmedRun = restored.run; preparedDescriptor = opts.restoreDescriptor;
        label = restored.labels?.[lang] || restored.label || label;
        confirmationText = restored.confirmationTexts?.[lang] || restored.confirmationText || null;
      } else if(typeof tool.prepareConfirmation==='function'){
        try {
          confirmedArgs=JSON.parse(JSON.stringify(args));
          const prepared=await tool.prepareConfirmation(confirmedArgs);
          if(typeof prepared?.run!=='function')throw Error('Vínculo de confirmação indisponível.');
          confirmedRun=prepared.run;preparedDescriptor=prepared.descriptor;
          // Algumas ações críticas só conhecem o efeito REAL depois de uma
          // consulta read-only ao provedor. O texto mostrado ao dono precisa
          // vir desse mesmo preparo vinculado, nunca dos argumentos inventados
          // pelo modelo (ex.: titular real de uma chave Pix ou valor do boleto).
          const preparedLabel = prepared?.labels?.[lang] || prepared?.label;
          if (typeof preparedLabel === 'string' && preparedLabel.trim()) {
            label = preparedLabel.trim();
            if (mailAddressWarning) label = `${label}. ${mailAddressWarning}`;
          }
          const preparedText = prepared?.confirmationTexts?.[lang] || prepared?.confirmationText;
          if (typeof preparedText === 'string' && preparedText.trim()) confirmationText = preparedText.trim();
        }catch(e){return `NÃO registrei o pedido: ${String(e?.message||'Não consegui vincular o alvo da confirmação.')} Nenhuma ação foi executada.`;}
      }
      // Another async proposal may have won while the target was being checked.
      if(!opts.confirmationPreview && !currentConfirmationSession(threadId) && pending.has(threadId))return 'Já existe uma ação aguardando confirmação nesta conversa. Nenhuma proposta foi substituída.';
      // O idioma vai GRAVADO na pendência, não relido na confirmação: o
      // resultado tem que sair na mesma língua do pedido que o dono aprovou.
      let durableId=null;
      if(!opts.confirmationPreview && !currentConfirmationSession(threadId) && tool.name==='gerenciar_tarefa_de_app' && preparedDescriptor&&opts.codingApprovals){
        try{
          const proposal=await opts.codingApprovals.propose({name:tool.name,label,args:confirmedArgs,binding:preparedDescriptor,language:lang,context:opts.codingApprovalContext||null});
          durableId=proposal.id;
          const execute=()=>tool.restoreConfirmation(confirmedArgs,preparedDescriptor).run();
          confirmedRun=()=>opts.codingApprovals.resolve(durableId,true,execute);
        }catch{return 'NÃO registrei o pedido: não consegui salvar a confirmação de forma segura. Nenhuma ação foi executada.';}
      }
      confirmationText ||= confirmationCard(tool.name, label, lang, !!currentConfirmationSession(threadId));
      if (opts.confirmationPreview) return { name: tool.name, label, args: confirmedArgs,
        binding: preparedDescriptor, confirmationText, language: lang, run: confirmedRun };
      const session = currentConfirmationSession(threadId);
      if (session) {
        try {
          const saved = await session.propose({ name: tool.name, label, args: confirmedArgs,
            binding: preparedDescriptor, confirmationText, language: lang,
            source: { ownerText: textoAtualDoDono.get(String(threadId)) || '',
              ownerHistory: textoDoDono.get(String(threadId)) || '', ...session.captureSource?.() } });
          // A tool pode dizer qual é o ALVO da proposta (ex.: a nota que
          // editar_nota vai trocar). Uma proposta nova pro mesmo alvo substitui
          // a anterior ainda pendente, em vez de empilhar cartões que brigam
          // entre si. Só depois de a nova estar gravada: se falhar, nada some.
          const alvo = typeof tool.supersedeKey === 'function' ? tool.supersedeKey(confirmedArgs) : null;
          if (alvo) {
            for (const old of session.pending()) {
              if (old.id === saved?.id || old.name !== tool.name || tool.supersedeKey(old.args || {}) !== alvo) continue;
              await session.close(old, 'superseded').catch(() => {});
            }
          }
          return `AÇÃO PENDENTE DE CONFIRMAÇÃO (NÃO foi executada). ${label}. O sistema apresentará os detalhes preparados e uma única pergunta. Não repita nem resuma esses detalhes (dias, horário, canal, valores) com suas palavras: o cartão é a única versão; responda só ao restante da mensagem. Não peça outra confirmação em prosa nem exija comandos ou números; a pessoa pode confirmar naturalmente, indicar o nome/horário ou responder à mensagem. Outros pedidos permanecem independentes.`;
        } catch (e) {
          return `NÃO registrei o pedido: ${String(e?.message || 'Falha ao salvar a confirmação.')} Nenhuma ação foi executada.`;
        }
      }
      pending.set(threadId, { id: randomUUID(), name: tool.name, label, run: confirmedRun, args:confirmedArgs, at: Date.now(), language: lang, durableId, confirmationText, messageRefs: [] });
      if (tool.name === 'jornada_configurar') {
        return `JORNADA AGUARDANDO CONFIRMAÇÃO (ainda não começou). Faça um convite curto e acolhedor usando estas informações: ${label} Diga que a pessoa pode confirmar com “sim” ou 👍. Não transforme isso em checklist e não acrescente avisos técnicos, jurídicos ou de privacidade.`;
      }
      // O cartão com os detalhes e a pergunta vai logo abaixo da resposta do
      // modelo (server.mjs). Pedir a confirmação aqui gerava duas perguntas e um
      // "prontinho" antes da hora (teste no dev, 29/09/2026).
      return `AÇÃO PENDENTE DE CONFIRMAÇÃO (NÃO foi executada). Registrei o pedido para ${label}. O sistema mostra logo abaixo da sua resposta um cartão com os detalhes e a única pergunta de confirmação. Não repita esses detalhes, não peça confirmação em prosa e não diga nem insinue que a ação já foi feita; responda só ao restante da mensagem (explicação, dúvida, formato pedido). Se não houver mais nada a responder, escreva uma frase curta, sem pergunta. A ação só roda quando a pessoa confirmar; se ela disser qualquer outra coisa, ela é cancelada.`;
    },
  };
}

// Adiciona ao registry uma lista de tools, envolvendo as perigosas com a trava.
// opts (mode/allowlist) é opcional: sem ele, comportamento = modo padrão (seguro).
export function addGated(registry, tools, threadId, opts = {}) {
  for (const t of tools) registry.add(gateTool(t, threadId, opts));
}

export function hasPending(threadId) { return currentConfirmationSession(threadId)?.pending().length > 0 || pending.has(threadId); }
// A confirmação de uma ação perigosa precisa ser resolvida na fronteira de
// um turno, pelo gate determinístico do server. Se o canal entregar um "pode"
// enquanto o turno que criou a pendência ainda está aberto, não consumimos a
// mensagem como interjeição do modelo: o adaptador do canal a mantém na fila e
// ela vira o próximo turno. Sem isso o modelo tentava chamar a tool de novo e
// recebia "já existe uma ação aguardando confirmação", embora o dono tivesse
// acabado de confirmar.
export function deferIncomingWhileConfirmationPending(threadId, poll) {
  if (typeof poll !== 'function') return null;
  return async () => hasPending(threadId) ? null : await poll();
}
export function listPending(threadId) { return currentConfirmationSession(threadId)?.pending() || (pending.has(threadId) ? [pending.get(threadId)] : []); }
export function peekPending(threadId) {
  const session = currentConfirmationSession(threadId);
  if (session) { const rows = session.pending(); return rows.length === 1 ? rows[0] : undefined; }
  return pending.get(threadId);
}
export function takePending(threadId) {
  // Durable transitions must go through the store, never an incidental legacy
  // "topic changed" branch that used to consume the only in-memory proposal.
  if (currentConfirmationSession(threadId)) return undefined;
  const p = pending.get(threadId);
  if (p) pending.delete(threadId);
  return p;
}
// Recoloca uma pendência (ex: reaction 👍 numa ação irreversível: a gente tira,
// vê que precisa de texto e devolve pra thread pra o usuário confirmar escrevendo).
export function restorePending(threadId, pend) {
  if (currentConfirmationSession(threadId)) return;
  if (!pend) return;
  // Pendências anteriores ao vínculo por mensagem recebem identidade nova.
  // Referências herdadas não podem autorizar essa restauração por coincidência;
  // o cartão reenviado poderá ser vinculado normalmente à identidade nova.
  if (!pend.id) pend = { ...pend, id: randomUUID(), messageRefs: [] };
  if (!pend.confirmationText) pend = { ...pend, confirmationText: confirmationCard(pend.name, pend.label || '', pend.language) };
  pending.set(threadId, pend);
}

// A referência vem do transporte (ID da mensagem enviada/citada), nunca do
// texto do usuário ou do modelo. O ID da proposta evita que uma resposta cujo
// envio terminou tarde vincule a mensagem de A à pendência mais recente B.
function messageReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { channel, messageId } = value;
  if (typeof channel !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(channel)) return null;
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 2048) return null;
  return { channel, messageId };
}

export function bindPendingMessage(threadId, pendingId, reference) {
  const pend = pending.get(threadId);
  const ref = messageReference(reference);
  if (!pend?.id || pend.id !== pendingId || !ref) return false;
  const refs = Array.isArray(pend.messageRefs) ? pend.messageRefs : [];
  if (!refs.some((r) => r.channel === ref.channel && r.messageId === ref.messageId)) {
    pend.messageRefs = [...refs, ref];
  }
  return true;
}

// Sem referência: mantém a confirmação textual simples. Referência explícita
// mas desconhecida/incompleta: falha fechada e NÃO consome a pendência. O canal
// deve passar um objeto mesmo quando uma citação/reação não puder ser resolvida.
// Serve também para recusa por reação: só cancelar depois de conferir o alvo.
export function confirmationTargetMatches(pend, target) {
  if (!pend) return false;
  if (target === undefined) return true;
  const ref = messageReference(target);
  if (!pend.id || !ref || !Array.isArray(pend.messageRefs)) return false;
  return pend.messageRefs.some((r) => r.channel === ref.channel && r.messageId === ref.messageId);
}

// Devolve o cartão atual sem pedir ao modelo que o reconstrua ou execute outra
// ação. O transporte pode vincular o novo envio à MESMA proposta, para a pessoa
// responder a ele. Não afirma que a ação citada anteriormente foi cancelada.
export function confirmationTargetNotice(pend) {
  const lang = tagIdioma(pend?.language || IDIOMA_PADRAO);
  if (!pend) return lang === 'en'
    ? 'There is no pending confirmation for that message. No action was executed. Please request the action again.'
    : lang === 'es'
      ? 'Ese mensaje no tiene una confirmación pendiente. No ejecuté ninguna acción. Pide la acción de nuevo.'
      : 'Essa mensagem não tem uma confirmação pendente. Nenhuma ação foi executada. Peça a ação novamente.';
  const card = String(pend.confirmationText || pend.label || '').trim();
  if (lang === 'en') return `I could not match your reply to the current confirmation request. The action is still pending.\n\n${card}\n\nTo confirm this action, reply “go ahead” to this message. To cancel it, reply “cancel” to this message.`;
  if (lang === 'es') return `No pude vincular tu respuesta con la confirmación actual. La acción sigue pendiente.\n\n${card}\n\nPara confirmar esta acción, responde “adelante” a este mensaje. Para cancelarla, responde “cancela” a este mensaje.`;
  return `Não consegui vincular sua resposta ao pedido de confirmação atual. A ação continua pendente.\n\n${card}\n\nPara confirmar essa ação, responda “pode” a esta mensagem. Para cancelar, responda “cancela” a esta mensagem.`;
}

// Generic confirmation stays deliberately narrow for dangerous actions. A
// discovery proposal is reversible and already names its subject, so natural
// wording such as "ok, podemos começar hoje" is enough for that proposal only.
export function confirmsPending(pend, message, target) {
  return confirmationTargetMatches(pend, target)
    && (isConfirmation(message)
      || (pend?.name === 'jornada_configurar' && configurationConfirmation(String(message || ''))));
}

// Detecta confirmação explícita do usuário na mensagem CRUA (no código, não no
// modelo). Conservador de propósito: na dúvida retorna false (ação cancelada).
// ATENÇÃO: essas regras valem pra QUALQUER idioma que o usuário fale, não só
// pt-BR. Enquanto só existia a lista em português, quem falava inglês dizia
// "yes"/"yeah" e a ação era cancelada em silêncio (o modelo ainda respondia
// "Done ✅" por cima). Ao mexer aqui, mantenha o viés conservador: na dúvida,
// false — negativa nova pode entrar solta, positiva nova só se não colidir com
// palavra comum de outra língua (ex: "vale" em pt/es executaria escrita à toa).
const NEG = /\b(n[ãa]o|nao|cancela|cancelar|espera|esquece|deixa pra?\s*(l[áa]|depois)?|pare|nem|melhor n[ãa]o|aguarda|peraí|pera[íi])\b/i;
// "para" left the list above and got its own rule (07/09/2026). As \bpara\b
// it matched the PREPOSITION, not the verb "parar" (stop): "sim, manda para o
// João" and even "confirmo, manda para ele" fell into the negative and
// cancelled SILENTLY, in pt and es ("sí, para el cliente"). The negative is
// tested first, so not even a "confirmo" next to it helped.
// It only counts as the verb "parar" in these forms, all incompatible with the
// preposition (which always needs a complement after it):
//   • "para" ending the message  -> "para", "para!", "ok, para"
//   • "para" + command closer    -> "para com isso", "para tudo", "para de mandar"
// Removing "para" from the negative executes NOTHING by itself: without NEG the
// phrase still needs a positive match to confirm. The conservative bias holds.
const PARA_STOP = /(?:^|[\s,;:])para\s*[!.…]*$|(?:^|[\s,;:])para\s+(?:com\s+isso|com\s+essa|tudo|agora|a[íi]|de\s+\w)/i;
// Fronteira do "no" inicial por \p{L}, não por \b: o \b do JS é ASCII, então
// uma palavra que começa com "no" e continua com letra ACENTUADA fecha fronteira
// pra ele. "noções alinhadas, pode enviar" casava `^no\b` (porque o "ç" conta
// como não-palavra) e virava negativa, cancelando em silêncio. Mesmo gênero de
// defeito do "para": fronteira ASCII sobre texto acentuado.
const NEG_EN = /^no(?!\p{L})|\b(nope|not|dont|cancel|cancels|canceled|cancelled|wait|stop|hold on|hold off|never ?mind|forget it|later|not yet)\b|do(es)?n['’]t/iu;
// Espanhol. Até aqui NÃO EXISTIA nenhuma negativa em espanhol: o dicionário es
// eram duas palavras ('sí' e 'adelante') penduradas dentro da regex de inglês.
// Um "no, cancela" só era pego por acaso, pelo `^no` do inglês; qualquer recusa
// em outra forma ("olvídalo", "mejor no", "todavía no") passava batido e a
// pessoa podia acabar confirmando o que quis recusar.
//
// O "no" solto do espanhol NÃO pode entrar aqui: em português "no" é a contração
// em+o ("publica no LinkedIn", "sobe no servidor"), então `no` solto cancelaria
// confirmações legítimas em pt. É a mesma armadilha do "para". Fica o `^no` do
// inglês (que pega "no, cancela") mais as formas em que o "no" espanhol vem
// seguido de pronome/verbo, combinação que não existe em português.
//
// "nunca" NÃO pode entrar solto aqui, pelo mesmo motivo do "para": é palavra
// comum do português em frase que CONFIRMA ("isso nunca falha, pode enviar",
// "nunca deu problema, pode subir"). Repare que ele nem está na NEG do português
// logo acima, justamente por isso. Fica valendo só quando é a fala inteira ou
// quando vem seguido de pronome/verbo espanhol que não existe em pt ("nunca lo
// hagas"). De fora ficam "nunca te" e "nunca se", que são português corrente
// ("nunca se sabe", "nunca te falei").
const NEG_ES = /\b(olv[íi]dalo|olv[íi]date|d[ée]jalo|d[ée]jame|todav[íi]a no|a[úu]n no|ahora no|mejor no|det[ée]nte|p[áa]rate|para nada|de ninguna manera)\b|^nunca\s*[!.…]*$|\bnunca\s+(lo|la|los|las|les|hagas|hagan|env[íi]es|mandes|publiques|subas)(?!\p{L})/iu;
// O "no" espanhol seguido de PRONOME ("no lo hagas") colide com a contração
// em+o do português quando o que vem depois é nome próprio: "manda no La Nación",
// "publica no Los Angeles Times" viravam negativa e cancelavam em silêncio. Em
// espanhol o pronome é sempre seguido de VERBO em minúscula; em português vem um
// nome próprio em maiúscula. Por isso esta parte é a única testada SEM /i: o
// pronome tem que estar em minúscula e a palavra seguinte também. O "No" com
// inicial maiúscula segue coberto pelo `[Nn]o` explícito.
const NEG_ES_NO = /(?<!\p{L})[Nn]o\s+(?:lo|la|los|las|le|les|te|se)\s+[a-záéíóúñü]|(?<!\p{L})[Nn]o\s+(?:hagas|hagan|env[íi]es|mandes|publiques|subas|crees|quiero|hace falta)(?!\p{L})/u;
const STRONG = /(confirmo|confirmar|confirmado|confirmei|autorizo|autorizado|pode (enviar|mandar|criar|subir|postar|comentar|fazer|seguir|ir|sim)|manda ver|manda a[íi]|envia a[íi]|pode sim|isso mesmo|t[áa] certo|est[áa] certo)/i;
const STRONG_EN = /(go ahead|please do|do it|send it|make it so|proceed|i (confirm|approve|authorize)|confirm(ed|s)?\b|approved?\b|authoriz(e|ed)\b|that(['’]s| is| s) (right|correct)|sounds good|looks good|lgtm|yes please|please go)/i;
// Autorização explícita em espanhol, equivalente ao "go ahead"/"do it" do
// STRONG_EN: vale em frase de qualquer tamanho.
//
// A fronteira (?<!\p{L})…(?!\p{L}) NÃO é decoração. Sem ela, e como esta regex é
// testada ANTES do limite de 4 palavras, as formas sem acento casavam DENTRO de
// palavra portuguesa e executavam ação irreversível: "o mandaloriano é minha
// série favorita" contém "mandalo" e confirmava. \b não serve aqui porque o \b
// do JS é ASCII e não fecha fronteira depois de letra acentuada ("hazlo" tudo
// bem, mas "hágalo" não).
// Ainda com a fronteira, os imperativos com pronome colado EXIGEM o acento, e
// isso também é regra e não capricho: sem acento, "mandalo" e "envialo" são o
// jeito (torto, sem hífen) de escrever "mandá-lo" e "enviá-lo" em português, e
// "preciso pensar antes de mandalo" executava a ação. Em espanhol o acento
// nessas formas é OBRIGATÓRIO (mándalo, envíalo, publícalo, súbelo, créalo,
// hágalo), então exigir a forma certa não perde espanhol escrito direito. Quem
// digita sem acento cai no viés conservador: não confirma, e a ação é cancelada
// em vez de disparada.
const STRONG_ES = /(?<!\p{L})(hazlo|házlo|hágalo|envíalo|mándalo|publícalo|súbelo|créalo|adelante|lo apruebo|apruebo|estoy de acuerdo|est[áa] bien|me parece bien|puedes? (enviar|mandar|crear|subir|publicar|hacer|seguir)(l[oa]s?|le|les)?)(?!\p{L})/iu;
const POS = /\b(sim|claro|isso|ok|okay|okk|beleza|blz|positivo|aprovo|aprovado|bora|manda|envia|envie|pode)\b|^(👍|✅|👌)/iu;
// Fronteira por \p{L} (não \b): "sí" termina em letra acentuada, e o \b do JS
// é ASCII, então \b não casaria depois do "í".
// "exactly" é o "isso" do inglês (frustração 25/09: "isso" não valia como sim).
const POS_EN = /(?<!\p{L})(yes|yeah|yeh|yep|yup|yessir|sure|correct|exactly|affirmative)(?!\p{L})/iu;
// Positivas curtas em espanhol (só valem em frase de até 4 palavras).
// "correcto"/"correcta" precisam de entrada própria: o `correct` do POS_EN tem
// (?!\p{L}) na frente, então trava justamente nas formas com sufixo.
// Fora da lista de propósito: "vale" (colide com o "vale" do português e
// executaria escrita à toa) e "venga" (também é subjuntivo de venir, "que venga
// mañana" viraria confirmação).
const POS_ES = /(?<!\p{L})(sí|de acuerdo|dale|perfecto|as[íi] es|eso es|exacto|por supuesto|correct[oa]|hecho)(?!\p{L})/iu;
// "si" SEM acento é ambíguo: em espanhol é o "se" condicional ("si puedes",
// "si quieres"), e com o limite de 4 palavras isso executaria uma ação real em
// cima de uma frase que não confirma nada. Então o "si" sem acento só conta
// quando é a fala INTEIRA. O "sí" acentuado não tem essa ambiguidade e continua
// valendo em qualquer posição (está no POS_ES).
const SI_SOZINHO = /^si\s*[!.…]*$/i;
// "eso" é o "isso" do espanhol, mas também abre frase que não confirma
// ("eso depende", "eso lo vemos después"). Por isso só vale sozinho ou
// colado num "sí": "eso", "sí, eso", "eso, sí".
const ESO_SOZINHO = /^(?:s[íi][, ]+)?eso(?:[, ]+s[íi])?\s*[!.…]*$/iu;
// Verbo de ação no imperativo: só vale como confirmação em frase CURTA (junto
// com a regra de <= 4 palavras), senão "quando publicar o app" executaria.
const ACT = /\b(publica|publicar|publique|sobe|suba|cria|crie|faz|faça|manda|envia)\b/i;

// ── Confirmação COM RESSALVA (achado #15) ──
// "pode sim, mas manda pro outro endereço" batia no STRONG ("pode sim") e
// executava a ação PENDENTE, com os dados ANTIGOS: a pessoa autorizou, só que
// autorizou OUTRA coisa. Agora isso não conta como confirmação; a pendência cai
// e o assistente propõe de novo já com a mudança, pedindo confirmação de novo.
// Só vale quando há ressalva E sinal de TROCA. Adversativa sozinha continua
// confirmando ("nunca se sabe, mas pode mandar"), que é português corrente.
const RESSALVA = /(?<!\p{L})(mas|por[ée]m|s[óo] que|no entanto|contudo|entretanto|todavia|but|however|pero|sin embargo|aunque)(?!\p{L})/iu;
const TROCA = /(?<!\p{L})(troc|mud|alter|corrig|chang|cambi|swap|replace|outr[oa]|otr[oa]|other|another|distint|difer|differ)/iu;
// Locução que POR SI só diz que é outra coisa: não precisa de adversativa.
const TROCA_SOZINHA = /(?<!\p{L})((em vez|ao inv[ée]s|no lugar|en vez|en lugar) d[eoa]s?|instead of)(?!\p{L})/iu;

// A mensagem autoriza, mas mudando o pedido? A troca tem que vir DEPOIS da
// ressalva; senão "troquei de ideia ontem, mas pode mandar" cancelaria à toa.
function mudaOPedido(t) {
  if (TROCA_SOZINHA.test(t)) return true;
  const m = RESSALVA.exec(t);
  return !!m && TROCA.test(t.slice(m.index + m[0].length));
}

// Pra quem cancelou: a pessoa CONFIRMOU, só que pedindo outra coisa. Quem chama
// usa isso pra explicar ao modelo que ele tem que repropor com a mudança, e não
// dizer "você não confirmou".
export function confirmacaoComRessalva(text) {
  const said = userSaid(text);
  if (!said) return false;
  const parts = said.split('\n').map((s2) => s2.trim()).filter(Boolean);
  if (parts.some((p2) => NEG.test(p2) || NEG_EN.test(p2) || NEG_ES.test(p2) || NEG_ES_NO.test(p2) || PARA_STOP.test(p2))) return false;
  // Sinal de "sim" SEM o limite de 4 palavras do confirmsPart: aqui nada é
  // executado, só se escolhe a explicação que vai pro modelo, e a frase com
  // ressalva é longa por natureza ("pode, mas manda para outro e-mail").
  const pareceSim = (t) => !t.endsWith('?') && (STRONG.test(t) || STRONG_EN.test(t) || STRONG_ES.test(t)
    || POS.test(t) || POS_EN.test(t) || POS_ES.test(t) || SI_SOZINHO.test(t) || ESO_SOZINHO.test(t) || ACT.test(t));
  return parts.some(mudaOPedido) && parts.some(pareceSim);
}

// Marcador do fim de um bloco de contexto injetado pelo CANAL (não é fala do
// usuário). Char invisível U+2063: o modelo lê o bloco normalmente, e a gente
// tem um âncora determinístico de onde ele termina. Não dá pra confiar no "]"
// porque o texto citado pelo usuário pode conter "]".
export const CHANNEL_CTX_END = '⁣';

// Devolve só o que a PESSOA escreveu, sem o envelope do canal. O WhatsApp
// injeta um bloco de contexto antes da mensagem quando ela usa "responder/
// citar", e esse bloco não pode participar da decisão de confirmar: a palavra
// "para" do PRÓPRIO bloco caía na lista de negativas e cancelava, em silêncio,
// QUALQUER confirmação feita por citação, em qualquer ação gated (caso real
// 18/08: "sim"/"confirmado"/👍 cancelados 8 vezes seguidas).
// Linha que o canal põe antes da transcrição de um áudio (voice-input.mjs).
// Não usa o CHANNEL_CTX_END de propósito: o canal junta mensagens seguidas, e
// num "não" digitado seguido de um áudio "sim" o lastIndexOf jogaria fora o
// "não". Sai linha por linha, então o resto do lote continua valendo.
export const VOICE_INPUT_NOTE = '[Mensagem de VOZ: o usuário mandou um áudio; abaixo vai a transcrição automática do que ele falou]';

export function userSaid(text) {
  const t = String(text || '');
  const i = t.lastIndexOf(CHANNEL_CTX_END);
  return (i >= 0 ? t.slice(i + 1) : t)
    .split('\n').filter((l) => l.trim() !== VOICE_INPUT_NOTE).join('\n').trim();
}

// Uma parte (uma mensagem) confirma?
function confirmsPart(t) {
  // Pergunta não é confirmação ("deu certo?", "pode?").
  if (t.endsWith('?')) return false;
  if (STRONG.test(t) || STRONG_EN.test(t) || STRONG_ES.test(t)) return true;  // autorização explícita
  const words = t.split(/\s+/).length;
  // Afirmativa curta ("sim", "pode", "ok", "yes", "sure", "sí", "dale", "publica").
  return words <= 4 && (POS.test(t) || POS_EN.test(t) || POS_ES.test(t) || SI_SOZINHO.test(t) || ESO_SOZINHO.test(t) || ACT.test(t));
}

export function isConfirmation(text) {
  const said = userSaid(text);
  if (!said) return false;
  // O canal agrupa mensagens seguidas da mesma pessoa juntando com "\n" (o
  // debounce do WhatsApp), então uma linha longa aqui pode ser só o vizinho de
  // um "sim". Avalia parte por parte, com o mesmo viés conservador.
  const parts = said.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  // Negação em qualquer idioma vem primeiro, e em QUALQUER parte: "não
  // confirma" e "don't send it" cancelam mesmo com uma positiva ao lado.
  if (parts.some((p) => NEG.test(p) || NEG_EN.test(p) || NEG_ES.test(p) || NEG_ES_NO.test(p) || PARA_STOP.test(p))) return false;
  // Autorizou mudando o pedido: não confirma a ação PENDENTE (essa é a antiga).
  if (parts.some(mudaOPedido)) return false;
  return parts.some(confirmsPart);
}
