import { configurationConfirmation, configurationLabel, completionLabel, retryLabel } from './discovery-conversation.mjs';
import { randomUUID } from 'node:crypto';
import { currentConfirmationSession } from './confirmation-session.mjs';
import { confirmedAction, actionEvidenceFor } from './action-evidence.mjs';
import { connectorActionReceipt, shareableLink } from './connector-action-evidence.mjs';
import { calendarRecurrence, recurrenceLabel, recurrenceOccurrences } from './calendar-recurrence.mjs';
// ── Confirmation guard for actions that CHANGE the user's world ──
//
// Write/destructive actions (send email, create event, upload file,
// create issue, comment, post) NEVER execute directly. When the model calls
// one of these tools, it only REGISTERS a pending action and returns a confirmation
// request. The actual execution only happens on the NEXT turn, when
// CODE (not the model) detects an explicit confirmation from the user in
// their raw message. This way the guard doesn't depend on the model's reasoning and resists
// prompt injection coming from content it read (email, document, etc.).
//
// When in doubt, the action doesn't execute. Persistent sessions keep requests
// independent and ask for clarification; the map below serves the legacy path.

// The confirmation text for a PURCHASE has to bring the REAL value of the cart
// built at the store, not a number the model repeated: that's the value the owner
// is approving. That's why the sentence comes from compras.mjs itself, built on top
// of the stored cart, and not from the call's args.
import { descreverCarrinho, plataformaDoCarrinho } from './compras.mjs';
// The routine's cadence is read by the SAME normalizer the tool uses to save,
// otherwise the confirmation card would describe a day different from what's going to be saved
// (the owner would confirm one thing and the platform would schedule another).
import { normalizeRoutineDays, routineDaysLabel, intervalLabel } from './scheduler.mjs';
import { routineArgsTimeLabel } from './routine-time.mjs';
// Card texts in English and Spanish. The pt-BR below stays INTACT: the
// en/es tables are consulted first and, when they don't have the sentence, the path
// falls back to the usual Portuguese. See the header of confirm-textos.mjs.
import { pedidoEm, feitoEm, molduraEm, copiaLabel, camposInfinity } from './confirm-textos.mjs';
import { tagIdioma, IDIOMA_PADRAO } from './locale.mjs';
import { PORTAO_TEXTOS, PORTAO_IRREVERSIVEIS, portaoTexto } from './confirm-textos-portao.mjs';
import { marca } from './marca.mjs';

const pending = new Map(); // Legacy callers/tests only. threadId -> { id, name, label, run, args, at, language, messageRefs }

const idiomaDaThread = new Map(); // threadId -> 'pt-BR' | 'en' | 'es'

// Language of this thread's owner. Stored per thread, and not passed as a
// parameter, for the same reason as setOwnerText: `addGated` is called in ~20
// places in server.mjs, almost all with just (registry, tools, thread.id), and
// stuffing the language into each of them is exactly the kind of change where an
// oversight slips by silently — the card would come out in Portuguese for a user
// only on that path, with no error appearing at all.
export function setThreadLanguage(threadId, language) {
  if (!threadId) return;
  const k = String(threadId);
  idiomaDaThread.delete(k); // reinsere no fim: o Map vira fila de descarte por idade
  idiomaDaThread.set(k, tagIdioma(language));
  if (idiomaDaThread.size > 500) idiomaDaThread.delete(idiomaDaThread.keys().next().value);
}

// Language to use on the card. With no record, it falls back to the default, which is
// today's pt-BR: a thread whose language wasn't recorded behaves exactly as
// it did before this change.
function idiomaDoCartao(threadId) {
  return idiomaDaThread.get(String(threadId)) || IDIOMA_PADRAO;
}

// How the confirmation card describes the requested channel. "app" (= not pushed on any
// channel) needs to become a sentence: "entregar no app" doesn't make clear to the owner
// that this is exactly the request to STOP receiving it on WhatsApp/Telegram/email.
function canalLabel(canal, { verbo = 'entregar', detalhe = true } = {}) {
  const c = String(canal || '').toLowerCase().trim();
  if (!c) return '';
  if (['app', 'none', 'nenhum', 'so app', 'só app'].includes(c)) {
    return `${verbo} só no app${detalhe ? ' (sem WhatsApp, Telegram nem e-mail)' : ''}`;
  }
  return `${verbo} no ${canal}`;
}

// Cadence text built from the tool's args (criar_rotina/editar_rotina).
// Returns '' when the call doesn't touch cadence (an edit of just the time, e.g.).
function cadenciaLabel(args = {}) {
  const cad = normalizeRoutineDays(args);
  if (cad.error || !cad.days) return '';
  return routineDaysLabel(cad.days);
}

// FULL cadence of the routine for the card ("every Sunday at 6pm", "every 30 min
// until ..."). Exists because the routine has two modes and the card only knew how
// to describe one: in INTERVAL mode there is no time or day, and the sentence came
// out "runs every day at 0?h", meaning the owner was confirming a routine that
// wasn't the one that was going to be created.
function cadenciaFrase(args = {}) {
  const n = Number(args.repetir_cada_min);
  if (Number.isFinite(n) && n > 0) {
    const ate = args.repetir_ate ? ` até ${args.repetir_ate}` : ' (sem data pra parar)';
    return `a cada ${intervalLabel(n)}${ate}`;
  }
  const hora = routineArgsTimeLabel(args) || '07h (padrão)';
  return `${cadenciaLabel(args) || 'todo dia'} às ${hora}`;
}

// Tools that require explicit human confirmation before executing.
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
  // They also write to the person's Drive, and exporting over a PDF with the same
  // name replaces the content that was already there. They were left out only
  // because the description asked "confirm before", which is a request to the
  // model, not a gate.
  'docs_create',
  'drive_export_pdf',
  'github_create_issue',
  'github_comment_issue',
  'slack_post_message',
  // Posts to the person's PUBLIC profile, in their name. It was left out: the only
  // guard was a sentence in the description asking the model to confirm, which is
  // a request, not a gate.
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
  // Although receiving money doesn't debit the balance, this tool can REGISTER a
  // real Pix key and create a charge QR code. This is a financial action, not
  // a query: it can never run just because the model interpreted a question
  // as a request to execute.
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
  // Public post in the person's name, indexed by search engines. Deleting it later
  // doesn't undo who already saw it: confirmation by text, a thumbs-up isn't enough.
  'linkedin_post',
  'confirmar_com_agente',
  'responder_decisao',
  'rodar_comando',
  'rodar_no_servidor',
  'git_push',
  'splitwise_add_expense',
  // A comment on Infinity is visible to the entire board team.
  'infinity_comentar',
  // Every financial action requires TEXT confirmation, including generating a
  // key/QR to receive money. Reaction and automation don't replace acceptance.
  'asaas_receber_pix',
  'asaas_pagar_conta',
  'asaas_cancelar_pagamento_conta',
  'asaas_transferir_pix',
  'asaas_enviar_comprovante_email',
  // Creates a real order, in the owner's name, at a real store. Money
  // goes out. A 👍 doesn't close a purchase: it has to be text confirmation.
  'fechar_pedido',
  // Opens a REAL payment account at a financial institution, in the owner's name and
  // with their CPF/CNPJ. There's no "un-opening" it, and the data goes to a third
  // party's credit analysis: requires text confirmation, never a thumbs-up.
  'criar_conta_brambs',
  ...PORTAO_IRREVERSIVEIS,
]);

// A gated action can be confirmed by REACTION (👍) only if it is NOT irreversible.
export function isReactionConfirmable(name) {
  return GATED_TOOLS.has(name) && !IRREVERSIBLE_TOOLS.has(name);
}

// The delivered card is for the same request the gate guarded. The model cannot
// swap the target in the wording nor offer 👍 when the action requires text acceptance.
function confirmationCard(name, label, language, numbered = false) {
  if (numbered) return label;
  if (name === 'jornada_configurar') return label;
  const reaction = isReactionConfirmable(name);
  const lang = tagIdioma(language || IDIOMA_PADRAO);
  if (lang === 'en') return `${label}\n\nTo confirm, reply “go ahead”${reaction ? ' or react with 👍' : ' in text'}.`;
  if (lang === 'es') return `${label}\n\nPara confirmar, responde “adelante”${reaction ? ' o reacciona con 👍' : ' por texto'}.`;
  return `${label}\n\nPara confirmar, responda “pode”${reaction ? ' ou reaja com 👍' : ' por texto'}.`;
}

// ── Email recipient: what the owner WROTE vs what is going to be sent ──
//
// The confirmation gate only really protects when the card shows the REAL action.
// When the address coming out of the call differs from what the person typed (a
// swapped letter, a "fixed" domain), the card displayed the already-changed address
// as if it were theirs: confirming had no way to catch the mistake, and the email
// went to the wrong place with the owner's "go ahead". Here the card now states
// the difference.
const MAIL_TOOLS = new Set(['gmail_send', 'hotmail_send', 'asaas_enviar_comprovante_email']);
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const textoDoDono = new Map(); // threadId -> raw text of its most recent messages
const textoAtualDoDono = new Map(); // threadId -> somente o pedido deste turno

// Text that the OWNER wrote in this thread (current turn + recent history).
// Stored by thread because `describe` only receives the tool's args, and the
// conversation is exactly the side that's missing to know whether the address
// was altered.
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

// Edit distance (Levenshtein). One swapped/missing letter = 1.
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

// Warns when the recipient isn't the same as an address the owner wrote, but is
// ALMOST the same (up to 2 letters different) — the signature of a "corrected"
// address along the way. Deliberately narrow, so it doesn't become noise on top
// of a legitimate send: it stays quiet when the owner didn't write any address
// at all (it came from contacts/history, normal use) and when the address is
// clearly a different one (recipient different on purpose).
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
  // FACTUAL sentence, never an instruction to the model: the label is printed raw
  // to the user in some paths (irreversible action, execution error), so it has
  // to read well both for the person and for the model. Being a mild alert,
  // a false positive (two similar addresses belonging to different people) costs
  // a double-check, not a scare.
  return `CONFIRA O ENDEREÇO: ${avisos.join('; ')}`;
}

// Readable summary of the action, for the agent to show the user before confirming.
//
// `language` is optional: without it, or in pt-BR, the path is the usual one (the
// switch in Portuguese below). In en/es it tries the translated table first and,
// if that tool doesn't have a sentence in that language yet, falls back to
// Portuguese instead of returning empty — on a card that authorizes spending
// money, missing text is worse than text in the wrong language.
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
      // The routine may come identified by its CODE (#xxxx) instead of its title,
      // when the owner has two with the same name; in that case the code is what
      // goes into the question.
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
    // Canva: the confirmation shows the FULL objective, because that's what the
    // sub-agent is going to execute. Summarizing here would hide from the owner
    // exactly the text that authorizes the action.
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
    // The owner needs to see exactly what data the account is going to be born
    // with: it's their CPF/CNPJ going to a credit analysis that can't be undone.
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
      // Without a cart there's no way to state the amount, and without an amount
      // there's no informed approval: the text has to make this explicit instead
      // of making it up.
      if (!resumo) return 'FECHAR UM PEDIDO DE VERDADE na loja (mas o carrinho não existe mais, então precisa ser montado de novo antes)';
      // A store outside VTEX won't let me close the sale: payment happens on its
      // own screen. Asking for authorization to "create a real order" there would
      // be promising something that doesn't happen.
      if (plataformaDoCarrinho(args.carrinho_id) !== 'vtex') {
        return `abrir o checkout da loja com esse carrinho pronto (${resumo}). Nessa loja quem finaliza o pagamento é você, na tela dela; eu não crio o pedido nem cobro nada`;
      }
      return `FECHAR O PEDIDO DE VERDADE: ${resumo}. Isso cria um pedido real no seu nome e gera a cobrança; não dá pra desfazer por aqui`;
    }
    case 'apagar_sistema':
      // The detail of what exists inside the app (number of records) is added by
      // the tool's `preflight`, which queries the host — here we only have the args.
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
      // A tool in the gate with no sentence of its own in any language: here the
      // pt-BR is also generic, so translating the generic one doesn't hide any
      // information.
      return lang === IDIOMA_PADRAO ? `executar a ação "${name}"` : molduraEm(lang).acaoPedido(name);
  }
}

// Formats an ISO date/time into a short pt-BR text (or returns the original).
// IMPORTANT: shows the WALL-CLOCK time exactly as it came in the ISO (without
// converting timezone). E.g.: "2026-07-09T11:30:00+02:00" -> "09/07/2026, 11:30".
// It used to convert to America/Sao_Paulo and distort the time for whoever is in
// another timezone (e.g. a user in Basel saw "06:30" instead of "11:30").
function formatWhen(s) {
  if (!s || typeof s !== 'string') return '';
  const str = s.trim();
  // Date only (all-day event): "2026-07-09" -> "09/07/2026".
  const dOnly = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dOnly) return `${dOnly[3]}/${dOnly[2]}/${dOnly[1]}`;
  // Date + time: extracts the literal wall-clock tokens, without timezone conversion.
  const dt = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dt) return `${dt[3]}/${dt[2]}/${dt[1]}, ${dt[4]}:${dt[5]}`;
  // Fallback: formato inesperado.
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return str; }
}

// Past-tense, readable sentence, for the user to see what WAS done (no raw JSON).
//
// This is the MOST critical text in the file for whoever doesn't speak Portuguese:
// unlike `describe`, which the model rewrites when showing the card, this
// sentence is printed DIRECTLY to the user by renderConfirmed. Without translation,
// whoever asked in English confirms in English and gets "E-mail enviado para ..."
// in Portuguese back.
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
    // Header only: the request detail (number, total, Pix) comes in the body that
    // the tool itself returns and renderConfirmed glues in below.
    case 'fechar_pedido':
      return 'Pedido feito na loja. Falta só o pagamento:';
    // Same idea: the body (account holder, branch/account and the NEXT step, just
    // one) comes from the tool itself. The header doesn't repeat "Asaas" nor
    // announce a pending list: the process was already explained before it opened.
    case 'criar_conta_brambs':
      return `Conta ${marca().nome} aberta no seu nome.`;
    default:
      return lang === IDIOMA_PADRAO ? `Ação "${name}" concluída.` : molduraEm(lang).acaoFeita(name);
  }
}

// Builds the CLEAN response after executing a confirmed action. Never exposes the
// tool's raw return (JSON) to the user: extracts only what matters (success/error
// and a possible link) and writes it in the owner's language.
//
// The language comes from `pend.language`, recorded when the action was
// REGISTERED, not read now: the confirmation happens in a later turn, and the
// request/result pair has to come out in the same language even if the owner
// switches language in between. An older pending action (recorded before this
// change, or restored from the database) doesn't have the field and falls back
// to pt-BR, today's default behavior.
// Tools with confirmation whose output is a fixed pt-BR success sentence.
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
    // Plain non-JSON text: the tool itself already returned something readable.
    if (!data && t) {
      // Textual errors stay actionable. Email success needs an ID.
      if (/^(?:ERRO|Não|Nao|Error|No |I couldn't)/i.test(t)) return t;
      const recibo = confirmedAction(pend.name, pend.args, r, lang);
      if (recibo) return recibo;
      // The tool's ready-made sentence is pt-BR ("Rotina X criada: roda..."):
      // whoever confirmed in English or Spanish gets the same action in their
      // language. Only where the translated sentence says exactly the same fact;
      // for a sending tool the text might say "scheduled" and the translation
      // would say "sent".
      const traduzido = m18n && FRASE_PRONTA_PT.has(pend.name) ? feitoEm(lang, pend.name, pend.args) : null;
      return traduzido || t;
    }
  }
  const uncertain = lang === 'en' ? 'The action has no verifiable completion confirmation. I will not automatically repeat it.' : lang === 'es' ? 'La acción no tiene confirmación verificable de finalización. No la repetiré automáticamente.' : 'A ação não tem confirmação verificável de conclusão. Não vou repeti-la automaticamente.';
  if (data?.action_evidence) return confirmedAction(pend.name, pend.args, r, lang) || uncertain;
  if (!data || (data.ok !== true && data.ok !== false)) return uncertain;
  if (data.ok !== false && data.skipped) return `${uncertain}${data.aviso ? '\n' + data.aviso : ''}`;
  // A known PENDING is a verifiable state of the institution, not an uncertain
  // failure. For Pix, the webhook closes the loop within the same conversation.
  // Transport uncertainty stays on the separate path (`incerto:true`) and keeps
  // the strong non-repetition warning.
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
  // Command output (e.g. rodar_no_servidor): shows stdout/stderr when present.
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
  // Connector confirmed by the service: the sentence states what was done with
  // the data the person approved (name, amount), instead of "Record created in
  // the service" with the group or board's internal ID (Splitwise, 2026-09-28).
  // Partial and "accepted by the service" still go through the generic receipt,
  // which is more precise.
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
  // Private app: the receipt is deterministic and the model just repeats the
  // reference, so username and password need to come out here or the person
  // never receives them.
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
  // Gate failed = no credential. With a credential, the warning is about
  // registration (replicar_sistema uses aviso_acesso for both cases).
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

// WRITE/mutation tools (code + server shell): in "aceitar_edicoes" mode they run
// INLINE (without the confirmation ceremony); in "plano" mode they are refused
// (read-only).
const CODING_WRITE = new Set(['editar_arquivo', 'escrever_arquivo', 'rodar_comando', 'rodar_no_servidor', 'git_commit', 'git_push', 'git_branch', 'git_checkout']);
// Tools that run shell commands: can be pre-authorized by prefix (allowlist).
const CMD_TOOLS = new Set(['rodar_comando', 'rodar_no_servidor']);

// Metacharacters that the remote shell interprets. With any of them in the rest
// of the command, what runs stops being "the command the owner authorized" and
// becomes an arbitrary chain ("git status && rm -rf /folder"). In that case the
// pre-authorization doesn't apply: the action is NOT refused, it just loses the
// shortcut and goes back to the normal confirmation flow.
const SHELL_META = /[;&|`$(){}<>\n\r\\]/;

// A command matches the allowlist if it's exactly an authorized prefix, or if it
// starts with "<prefix> " (word boundary, so "git" doesn't allow "github...") AND
// the rest doesn't carry a shell metacharacter.
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

// Wraps a "dangerous" tool. Behavior depends on the agent's permission MODE
// (opts.mode) and the command allowlist (opts.allowlist):
//  • padrao          -> registers a pending action and requires confirmation (safe default).
//  • aceitar_edicoes -> coding-write tools run INLINE, result in the same turn.
//  • plano           -> coding-write tools are refused (nothing is changed).
//  • allowlist       -> pre-authorized command runs INLINE in any mode.
// Tools outside GATED_TOOLS pass through untouched, except dynamically-named ones
// that arrive marked with `requiresConfirmation: true` (e.g. MCP connectors, whose
// name is only known at execution time).
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
      // Every gate keeps its own snapshot of the arguments, not just tools with
      // special preparation. The caller might reuse/mutate the object while a
      // preflight is waiting; that must not change the request that is going to
      // be confirmed.
      try { args = JSON.parse(JSON.stringify(args || {})); }
      catch { return 'NÃO registrei o pedido: parâmetros inválidos. Nenhuma ação foi executada.'; }
      // Validates BEFORE creating the pending action: an error never becomes a
      // one-off event nor a misleading confirmation request. The connector
      // repeats the validation before the HTTP call.
      if (['calendar_create', 'outlook_calendar_create'].includes(tool.name)) {
        try { calendarRecurrence(args?.recorrencia, args?.start || args?.inicio, args?.timezone || args?.fuso); }
        catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
      }

      // Plan mode: changes nothing.
      if (mode === 'plano' && CODING_WRITE.has(tool.name)) {
        return `MODO PLANO ativo: não altero nada agora. Descreva o que faria (arquivo/comando) e peça pro usuário liberar (ex: "pode aplicar" ou trocar pra o modo padrão/aceitar edições) antes de executar.`;
      }
      // Inline execution (skips confirmation): aceitar_edicoes mode for
      // coding-write, or a pre-authorized command in the allowlist.
      const inlineByMode = (mode === 'aceitar_edicoes' || mode === 'livre') && CODING_WRITE.has(tool.name);
      const inlineByAllow = CMD_TOOLS.has(tool.name) && cmdAllowed(args?.comando, allowlist);
      if (!opts.confirmationPreview && (inlineByMode || inlineByAllow)) {
        return tool.run(args);
      }
      // Some mutations are strictly risk-reducing and reversible
      // (today: only PAUSING a routine, without changing anything else). The
      // tool itself declares this narrow exception; we never infer it from the
      // name nor from the model's text. It still goes through the preflight
      // below before executing, to validate and resolve the real target.
      const inlineByPolicy = typeof tool.runWithoutConfirmation === 'function'
        && tool.runWithoutConfirmation(args) === true;
      // The legacy path keeps a single pending action; the persistent session
      // supports several.
      if (!opts.confirmationPreview && !currentConfirmationSession(threadId) && pending.has(threadId)) {
        return 'Já existe uma ação aguardando a confirmação do usuário nesta conversa. Trate uma de cada vez: confirme (ou cancele) a anterior antes de propor outra.';
      }
      const lang = idiomaDoCartao(threadId);
      // Some tools need to cross-check the model's arguments against this
      // turn's literal intent before building the confirmation. Example: a
      // boleto's due date doesn't authorize the model to invent a schedule.
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
      // Dynamically-named tool has no sentence in describe(): it describes the
      // request itself.
      let label = (typeof tool.describeConfirmation === 'function' && tool.describeConfirmation(args, lang)) || describe(tool.name, args, lang);
      let mailAddressWarning = '';
      // Email: if the recipient diverges from what the owner wrote, this goes
      // into the card. Without this the card displayed the altered address as
      // if it were theirs.
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
      // Optional enrichment: the tool can offer a `preflight(args)` that queries
      // the REAL state before confirmation, so the user doesn't confirm blind
      // (e.g. how many records die when deleting an app). Contract:
      // READ-ONLY, returns `{ aviso }`, `{ erro }` or nothing. Best-effort — if
      // it fails or is slow, the gate still stands with the basic label.
      //
      // `erro` = an argument the tool ALREADY KNOWS it's going to reject (hour 25,
      // a weekday that doesn't exist). Without this, the request became a
      // confirmation card describing the rounded value, the owner confirmed, and
      // only then did the tool refuse: they had confirmed something that never
      // existed. Going back now, the model corrects it in the same turn.
      let recusa = null;
      try {
        const extra = await (restored?.preflight || tool.preflight)?.(args);
        if (extra && extra.erro) recusa = String(extra.erro);
        else if (extra && extra.aviso) label = `${label}. ${extra.aviso}`;
      } catch (e) {
        if (opts.confirmationPreview || currentConfirmationSession(threadId)) throw Error('Não consegui conferir novamente o alvo da confirmação.');
        /* continues with the basic label */
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
          // Some critical actions only know the REAL effect after a read-only
          // query to the provider. The text shown to the owner needs to come
          // from that same bound preparation, never from arguments invented
          // by the model (e.g. a Pix key's real holder or a boleto's amount).
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
      // The language gets RECORDED in the pending action, not re-read at
      // confirmation time: the result has to come out in the same language as
      // the request the owner approved.
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
          // The tool can state what the TARGET of the proposal is (e.g. the note
          // that editar_nota is going to change). A new proposal for the same
          // target replaces the previous still-pending one, instead of stacking
          // cards that conflict with each other. Only after the new one is
          // recorded: if it fails, nothing disappears.
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
      // The card with the details and the question goes right below the model's
      // response (server.mjs). Asking for confirmation here produced two
      // questions and an early "all done" (tested on dev, 2026-09-29).
      return `AÇÃO PENDENTE DE CONFIRMAÇÃO (NÃO foi executada). Registrei o pedido para ${label}. O sistema mostra logo abaixo da sua resposta um cartão com os detalhes e a única pergunta de confirmação. Não repita esses detalhes, não peça confirmação em prosa e não diga nem insinue que a ação já foi feita; responda só ao restante da mensagem (explicação, dúvida, formato pedido). Se não houver mais nada a responder, escreva uma frase curta, sem pergunta. A ação só roda quando a pessoa confirmar; se ela disser qualquer outra coisa, ela é cancelada.`;
    },
  };
}

// Adds a list of tools to the registry, wrapping the dangerous ones with the gate.
// opts (mode/allowlist) is optional: without it, behavior = default mode (safe).
export function addGated(registry, tools, threadId, opts = {}) {
  for (const t of tools) registry.add(gateTool(t, threadId, opts));
}

export function hasPending(threadId) { return currentConfirmationSession(threadId)?.pending().length > 0 || pending.has(threadId); }
// Confirming a dangerous action needs to be resolved at a turn boundary, by the
// server's deterministic gate. If the channel delivers a "go ahead" while the turn
// that created the pending action is still open, we don't consume the message as
// an interjection from the model: the channel adapter keeps it queued and it
// becomes the next turn. Without this the model would try calling the tool again
// and get "there's already an action waiting for confirmation", even though the
// owner had just confirmed.
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
// Restores a pending action (e.g. 👍 reaction on an irreversible action: we take
// it back, see it needs text, and return it to the thread for the user to confirm
// by writing).
export function restorePending(threadId, pend) {
  if (currentConfirmationSession(threadId)) return;
  if (!pend) return;
  // Pending actions from before the per-message link get a new identity.
  // Inherited references can't authorize this restoration by coincidence;
  // the resent card can be linked normally to the new identity.
  if (!pend.id) pend = { ...pend, id: randomUUID(), messageRefs: [] };
  if (!pend.confirmationText) pend = { ...pend, confirmationText: confirmationCard(pend.name, pend.label || '', pend.language) };
  pending.set(threadId, pend);
}

// The reference comes from the transport (ID of the sent/quoted message), never
// from the user's or model's text. The proposal's ID avoids a reply whose sending
// finished late linking message A's response to the more recent pending action B.
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

// No reference: keeps the simple textual confirmation. Explicit but
// unknown/incomplete reference: fails closed and does NOT consume the pending
// action. The channel must pass an object even when a quote/reaction can't be
// resolved. Also used for refusal by reaction: only cancel after checking the target.
export function confirmationTargetMatches(pend, target) {
  if (!pend) return false;
  if (target === undefined) return true;
  const ref = messageReference(target);
  if (!pend.id || !ref || !Array.isArray(pend.messageRefs)) return false;
  return pend.messageRefs.some((r) => r.channel === ref.channel && r.messageId === ref.messageId);
}

// Returns the current card without asking the model to rebuild it or execute
// another action. The transport can link the new send to the SAME proposal, for
// the person to reply to it. It does not claim that the previously cited action
// was cancelled.
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

// Detects explicit user confirmation in the RAW message (in code, not in the
// model). Deliberately conservative: when in doubt returns false (action
// cancelled).
// ATTENTION: these rules apply to ANY language the user speaks, not just
// pt-BR. While only the Portuguese list existed, English speakers would say
// "yes"/"yeah" and the action was cancelled silently (the model would still
// reply "Done ✅" on top of it). When touching this, keep the conservative bias:
// when in doubt, false — a new negative can go in freely, a new positive only if
// it doesn't collide with a common word from another language (e.g. "vale" in
// pt/es would execute a write for no reason).
const NEG = /\b(n[ãa]o|nao|cancela|cancelar|espera|esquece|deixa pra?\s*(l[áa]|depois)?|pare|nem|melhor n[ãa]o|aguarda|peraí|pera[íi])\b/i;
// "para" left the list above and got its own rule (2026-09-07). As \bpara\b
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
// Boundary of the initial "no" by \p{L}, not by \b: JS's \b is ASCII, so
// a word that starts with "no" and continues with an ACCENTED letter closes the
// boundary for it. "noções alinhadas, pode enviar" matched `^no\b` (because the
// "ç" counts as a non-word character) and became a negative, cancelling silently.
// Same kind of bug as "para": ASCII boundary over accented text.
const NEG_EN = /^no(?!\p{L})|\b(nope|not|dont|cancel|cancels|canceled|cancelled|wait|stop|hold on|hold off|never ?mind|forget it|later|not yet)\b|do(es)?n['’]t/iu;
// Spanish. Until now there was NO negative in Spanish at all: the es
// dictionary was just two words ('sí' and 'adelante') hanging inside the
// English regex. A "no, cancela" was only caught by chance, by English's `^no`;
// any refusal in another form ("olvídalo", "mejor no", "todavía no") went
// through unnoticed and the person could end up confirming what they meant to
// refuse.
//
// Spanish's standalone "no" CANNOT go in here: in Portuguese "no" is the
// contraction of em+o ("publica no LinkedIn", "sobe no servidor"), so a
// standalone `no` would cancel legitimate confirmations in pt. Same trap as
// "para". English's `^no` stays (which catches "no, cancela") plus the forms
// where Spanish's "no" is followed by a pronoun/verb, a combination that doesn't
// exist in Portuguese.
//
// "nunca" CANNOT go in standalone here either, for the same reason as "para": it's
// a common Portuguese word in a sentence that CONFIRMS ("isso nunca falha, pode
// enviar", "nunca deu problema, pode subir"). Note it isn't even in Portuguese's
// NEG right above, exactly for that reason. It only counts when it's the whole
// message or when followed by a Spanish pronoun/verb that doesn't exist in pt
// ("nunca lo hagas"). Left out are "nunca te" and "nunca se", which are everyday
// Portuguese ("nunca se sabe", "nunca te falei").
const NEG_ES = /\b(olv[íi]dalo|olv[íi]date|d[ée]jalo|d[ée]jame|todav[íi]a no|a[úu]n no|ahora no|mejor no|det[ée]nte|p[áa]rate|para nada|de ninguna manera)\b|^nunca\s*[!.…]*$|\bnunca\s+(lo|la|los|las|les|hagas|hagan|env[íi]es|mandes|publiques|subas)(?!\p{L})/iu;
// Spanish's "no" followed by a PRONOUN ("no lo hagas") collides with
// Portuguese's em+o contraction when what follows is a proper name: "manda no
// La Nación", "publica no Los Angeles Times" became a negative and cancelled
// silently. In Spanish the pronoun is always followed by a lowercase VERB; in
// Portuguese it's followed by a capitalized proper name. That's why this part
// is the only one tested WITHOUT /i: the pronoun has to be lowercase and the
// following word too. The capitalized "No" is still covered by the explicit
// `[Nn]o`.
const NEG_ES_NO = /(?<!\p{L})[Nn]o\s+(?:lo|la|los|las|le|les|te|se)\s+[a-záéíóúñü]|(?<!\p{L})[Nn]o\s+(?:hagas|hagan|env[íi]es|mandes|publiques|subas|crees|quiero|hace falta)(?!\p{L})/u;
const STRONG = /(confirmo|confirmar|confirmado|confirmei|autorizo|autorizado|pode (enviar|mandar|criar|subir|postar|comentar|fazer|seguir|ir|sim)|manda ver|manda a[íi]|envia a[íi]|pode sim|isso mesmo|t[áa] certo|est[áa] certo)/i;
const STRONG_EN = /(go ahead|please do|do it|send it|make it so|proceed|i (confirm|approve|authorize)|confirm(ed|s)?\b|approved?\b|authoriz(e|ed)\b|that(['’]s| is| s) (right|correct)|sounds good|looks good|lgtm|yes please|please go)/i;
// Explicit authorization in Spanish, equivalent to STRONG_EN's "go ahead"/"do
// it": valid in a sentence of any length.
//
// The boundary (?<!\p{L})…(?!\p{L}) is NOT decoration. Without it, and since
// this regex is tested BEFORE the 4-word limit, the unaccented forms would
// match INSIDE a Portuguese word and execute an irreversible action: "o
// mandaloriano é minha série favorita" contains "mandalo" and would confirm.
// \b doesn't work here because JS's \b is ASCII and doesn't close a boundary
// after an accented letter ("hazlo" is fine, but "hágalo" is not).
// Even with the boundary, imperatives with an attached pronoun REQUIRE the
// accent, and that is also a rule, not a whim: without the accent, "mandalo"
// and "envialo" are the (crooked, hyphen-less) way of writing "mandá-lo" and
// "enviá-lo" in Portuguese, and "preciso pensar antes de mandalo" would execute
// the action. In Spanish the accent on these forms is MANDATORY (mándalo,
// envíalo, publícalo, súbelo, créalo, hágalo), so requiring the correct form
// doesn't lose properly-written Spanish. Whoever types without the accent falls
// into the conservative bias: it doesn't confirm, and the action is cancelled
// instead of triggered.
const STRONG_ES = /(?<!\p{L})(hazlo|házlo|hágalo|envíalo|mándalo|publícalo|súbelo|créalo|adelante|lo apruebo|apruebo|estoy de acuerdo|est[áa] bien|me parece bien|puedes? (enviar|mandar|crear|subir|publicar|hacer|seguir)(l[oa]s?|le|les)?)(?!\p{L})/iu;
const POS = /\b(sim|claro|isso|ok|okay|okk|beleza|blz|positivo|aprovo|aprovado|bora|manda|envia|envie|pode)\b|^(👍|✅|👌)/iu;
// Boundary by \p{L} (not \b): "sí" ends in an accented letter, and JS's \b
// is ASCII, so \b wouldn't match after the "í".
// "exactly" is English's "isso" (frustration on 2026-09-25: "isso" didn't
// count as a yes).
const POS_EN = /(?<!\p{L})(yes|yeah|yeh|yep|yup|yessir|sure|correct|exactly|affirmative)(?!\p{L})/iu;
// Short Spanish positives (only valid in a sentence of up to 4 words).
// "correcto"/"correcta" need their own entry: POS_EN's `correct` has
// (?!\p{L}) in front, which specifically blocks the suffixed forms.
// Left out on purpose: "vale" (collides with Portuguese's "vale" and would
// execute a write for no reason) and "venga" (also venir's subjunctive, "que
// venga mañana" would become a confirmation).
const POS_ES = /(?<!\p{L})(sí|de acuerdo|dale|perfecto|as[íi] es|eso es|exacto|por supuesto|correct[oa]|hecho)(?!\p{L})/iu;
// "si" WITHOUT an accent is ambiguous: in Spanish it's the conditional "se"
// ("si puedes", "si quieres"), and with the 4-word limit this would execute a
// real action on top of a sentence that doesn't confirm anything. So unaccented
// "si" only counts when it's the WHOLE message. Accented "sí" doesn't have this
// ambiguity and still counts in any position (it's in POS_ES).
const SI_SOZINHO = /^si\s*[!.…]*$/i;
// "eso" is Spanish's "isso", but it also opens a sentence that doesn't confirm
// ("eso depende", "eso lo vemos después"). So it only counts alone or attached
// to a "sí": "eso", "sí, eso", "eso, sí".
const ESO_SOZINHO = /^(?:s[íi][, ]+)?eso(?:[, ]+s[íi])?\s*[!.…]*$/iu;
// Action verb in the imperative: only counts as confirmation in a SHORT sentence
// (together with the <= 4-word rule), otherwise "quando publicar o app" would execute.
const ACT = /\b(publica|publicar|publique|sobe|suba|cria|crie|faz|faça|manda|envia)\b/i;

// ── Confirmation WITH A CAVEAT (finding #15) ──
// "pode sim, mas manda pro outro endereço" matched STRONG ("pode sim") and
// executed the PENDING action, with the OLD data: the person authorized, except
// they authorized something ELSE. Now this doesn't count as confirmation; the
// pending action drops and the assistant proposes again already with the change,
// asking for confirmation again. Only counts when there's both a caveat AND a
// sign of CHANGE. A standalone adversative still confirms ("nunca se sabe, mas
// pode mandar"), which is everyday Portuguese.
const RESSALVA = /(?<!\p{L})(mas|por[ée]m|s[óo] que|no entanto|contudo|entretanto|todavia|but|however|pero|sin embargo|aunque)(?!\p{L})/iu;
const TROCA = /(?<!\p{L})(troc|mud|alter|corrig|chang|cambi|swap|replace|outr[oa]|otr[oa]|other|another|distint|difer|differ)/iu;
// A phrase that BY ITSELF says it's something else: doesn't need an adversative.
const TROCA_SOZINHA = /(?<!\p{L})((em vez|ao inv[ée]s|no lugar|en vez|en lugar) d[eoa]s?|instead of)(?!\p{L})/iu;

// Does the message authorize, but changing the request? The change has to come
// AFTER the caveat; otherwise "troquei de ideia ontem, mas pode mandar" would
// cancel for no reason.
function mudaOPedido(t) {
  if (TROCA_SOZINHA.test(t)) return true;
  const m = RESSALVA.exec(t);
  return !!m && TROCA.test(t.slice(m.index + m[0].length));
}

// For whoever cancelled: the person DID CONFIRM, just asking for something else.
// The caller uses this to explain to the model that it has to re-propose with the
// change, and not say "you didn't confirm".
export function confirmacaoComRessalva(text) {
  const said = userSaid(text);
  if (!said) return false;
  const parts = said.split('\n').map((s2) => s2.trim()).filter(Boolean);
  if (parts.some((p2) => NEG.test(p2) || NEG_EN.test(p2) || NEG_ES.test(p2) || NEG_ES_NO.test(p2) || PARA_STOP.test(p2))) return false;
  // Signal of "yes" WITHOUT confirmsPart's 4-word limit: nothing is executed
  // here, it only picks which explanation goes to the model, and the sentence
  // with a caveat is naturally long ("pode, mas manda para outro e-mail").
  const pareceSim = (t) => !t.endsWith('?') && (STRONG.test(t) || STRONG_EN.test(t) || STRONG_ES.test(t)
    || POS.test(t) || POS_EN.test(t) || POS_ES.test(t) || SI_SOZINHO.test(t) || ESO_SOZINHO.test(t) || ACT.test(t));
  return parts.some(mudaOPedido) && parts.some(pareceSim);
}

// Marker for the end of a context block injected by the CHANNEL (not the user's
// speech). Invisible char U+2063: the model reads the block normally, and we
// have a deterministic anchor for where it ends. Can't rely on "]" because the
// text the user quoted might contain "]".
export const CHANNEL_CTX_END = '⁣';

// Returns only what the PERSON wrote, without the channel's envelope. WhatsApp
// injects a context block before the message when it uses "reply/quote", and
// that block can't take part in the confirmation decision: the word "para" from
// the block ITSELF fell into the list of negatives and cancelled, silently, ANY
// confirmation made by quoting, in any gated action (real case on 2026-08-18:
// "sim"/"confirmado"/👍 cancelled 8 times in a row).
// Line the channel places before an audio transcription (voice-input.mjs).
// Doesn't use CHANNEL_CTX_END on purpose: the channel joins consecutive
// messages, and in a typed "não" followed by a "sim" audio, lastIndexOf would
// throw away the "não". It goes line by line, so the rest of the batch still
// counts.
export const VOICE_INPUT_NOTE = '[Mensagem de VOZ: o usuário mandou um áudio; abaixo vai a transcrição automática do que ele falou]';

export function userSaid(text) {
  const t = String(text || '');
  const i = t.lastIndexOf(CHANNEL_CTX_END);
  return (i >= 0 ? t.slice(i + 1) : t)
    .split('\n').filter((l) => l.trim() !== VOICE_INPUT_NOTE).join('\n').trim();
}

// Does a part (a message) confirm?
function confirmsPart(t) {
  // A question is not a confirmation ("deu certo?", "pode?").
  if (t.endsWith('?')) return false;
  if (STRONG.test(t) || STRONG_EN.test(t) || STRONG_ES.test(t)) return true;  // explicit authorization
  const words = t.split(/\s+/).length;
  // Short affirmative ("sim", "pode", "ok", "yes", "sure", "sí", "dale", "publica").
  return words <= 4 && (POS.test(t) || POS_EN.test(t) || POS_ES.test(t) || SI_SOZINHO.test(t) || ESO_SOZINHO.test(t) || ACT.test(t));
}

export function isConfirmation(text) {
  const said = userSaid(text);
  if (!said) return false;
  // The channel groups consecutive messages from the same person by joining them
  // with "\n" (WhatsApp's debounce), so a long line here can just be the
  // neighbor of a "sim". Evaluates part by part, with the same conservative bias.
  const parts = said.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  // Negation in any language comes first, and in ANY part: "não confirma" and
  // "don't send it" cancel even with a positive right next to it.
  if (parts.some((p) => NEG.test(p) || NEG_EN.test(p) || NEG_ES.test(p) || NEG_ES_NO.test(p) || PARA_STOP.test(p))) return false;
  // Authorized while changing the request: doesn't confirm the PENDING action
  // (that one is the old one).
  if (parts.some(mudaOPedido)) return false;
  return parts.some(confirmsPart);
}
