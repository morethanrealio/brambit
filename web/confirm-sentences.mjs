// Sentences of the confirmation card: what the assistant asks to do (request)
// and what it did (done), in every language through the same code. The text is
// in the catalogs under `confirm.*` (web/locales); this file only computes the
// variables: defaults, cuts, optional clauses, dates by language.
//
// This is the only card text written by code instead of by the model: it is
// what the owner approves and what they get back. So every value that the
// action will use has to show up here (amount, recipient, copy, key...), and an
// optional clause is its own key that fills a placeholder of the sentence.
import { productI18n } from './i18n.mjs';
import { normalizeRoutineDays, parseRoutineDays } from './scheduler.mjs';
import { routineArgsTimeLabel, routineTimeLabel } from './routine-time.mjs';
import { descreverCarrinho, plataformaDoCarrinho } from './compras.mjs';
import { marca } from './marca.mjs';
import { configurationLabel, completionLabel, retryLabel } from './discovery-conversation.mjs';

// Looks up `confirm.<key>` in one language; every placeholder must be passed.
function context(lang) {
  const { t } = productI18n();
  const tr = (key, vars) => t(`confirm.${key}`, lang, vars);
  return {
    lang,
    t: tr,
    // `value`, or the catalog's placeholder text when it is empty.
    or: (value, key) => (value ? String(value) : tr(key)),
    // `value` (?? semantics, like the old tables' q()), or the placeholder text.
    q: (value, key) => (value ?? null) !== null ? String(value) : (key ? tr(key) : ''),
    // Optional clause: the key's text when `on`, else ''.
    clause: (on, key, vars) => (on ? tr(key, vars) : ''),
  };
}

// The cc goes out in the real send, so the card that authorizes it must show it.
const copyTo = (cc, c) => {
  const v = String(cc == null ? '' : cc).trim();
  return v ? c.t('common.copy_to', { cc: v }) : '';
};

const email = (tool) => ({
  request: (a, c) => c.t(`${tool}.request`, { to: c.or(a.to, 'common.recipient_unknown'), subject: c.clause(a.subject, 'common.with_subject', { subject: a.subject }), cc: copyTo(a.cc, c) }),
  done: (a, c) => c.t(`${tool}.done`, { to: c.or(a.to, 'common.the_recipient'), subject: c.clause(a.subject, 'common.with_subject', { subject: a.subject }), cc: copyTo(a.cc, c) }),
});

// Wall-clock date and time of an ISO string, as it came: converting the time
// zone would move the time for someone outside the server's zone. English names
// the month, since "09/07/2026" is a different day for DD/MM and MM/DD readers
// and the person is approving a calendar time.
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(s, lang) {
  if (!s || typeof s !== 'string') return '';
  const str = s.trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/) || str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) {
    const [, year, month, day, hh, mm] = m;
    const time = hh ? `, ${hh}:${mm}` : '';
    return lang === 'en' ? `${MONTHS_EN[Number(month) - 1]} ${Number(day)}, ${year}${time}` : `${day}/${month}/${year}${time}`;
  }
  // Any other format: Portuguese keeps its old rendering; other languages show
  // the text as it came instead of guessing the reader's day/month order.
  if (lang !== 'pt-BR') return str;
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// "(title, time...)" of an event edit: request says what changes to, done what changed.
const eventChanges = (a, c, f, kind) => {
  const parts = [];
  if (a[f.title] != null) parts.push(c.t(kind === 'request' ? 'event.title_to' : 'event.title', { title: a[f.title] }));
  if (a[f.start] != null) parts.push(c.t(kind === 'request' ? 'event.time_to' : 'event.time', { date: when(a[f.start], c.lang) + (kind === 'done' && f.tz && a[f.tz] ? ` (${a[f.tz]})` : '') }));
  if (a[f.location] != null) parts.push(c.t(kind === 'request' ? 'event.location_to' : 'event.location', { location: a[f.location] }));
  if (a[f.description] != null) parts.push(c.t(kind === 'request' ? 'event.the_description' : 'event.description'));
  if (f.guests(a)) parts.push(c.t(kind === 'request' ? 'event.the_guests' : 'event.guests'));
  return c.clause(parts.length, `event.changes_${kind}`, { list: parts.join(', ') });
};
const GOOGLE_EVENT = { title: 'title', start: 'start', tz: 'timezone', location: 'location', description: 'description', guests: (a) => a.attendees?.length };
const OUTLOOK_EVENT = { title: 'titulo', start: 'inicio', location: 'local', description: 'descricao', guests: (a) => a.convidados != null };

// " in <dir>" of the git tools.
const inDir = (a, c) => c.clause(a.diretorio, 'common.in_dir', { dir: a.diretorio });
const pushBranch = (a, c) => c.t(a.branch ? 'git_push.of_branch' : 'git_push.current_branch', { branch: a.branch });
const runCommand = {
  request: (a, c) => c.t('run_command.request', { command: a.comando || '', host: c.clause(a.host, 'run_command.host', { host: a.host }) }),
  done: (a, c) => c.t('run_command.done', { host: c.clause(a.host, 'run_command.host', { host: a.host }) }),
};
const hostFile = (tool) => ({
  request: (a, c) => c.t(`${tool}.request`, { path: c.or(a.caminho, 'common.unknown'), host: c.clause(a.host, 'common.on_host', { host: a.host }) }),
  done: (a, c) => c.t(`${tool}.done`, { path: a.caminho || '' }),
});
// ── Routines ────────────────────────────────────────────────────────────
// The cadence is built from the same `parseRoutineDays` the tool uses to save,
// so the card can't describe a day different from the one that will be stored.
const APP_ONLY = ['app', 'none', 'nenhum', 'so app', 'só app'];
const isAppOnly = (canal) => APP_ONLY.includes(String(canal || '').toLowerCase().trim());

function joinList(names, c) {
  return names.length === 1 ? names[0] : c.t('routine.list', { init: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}

function routineDays(args, c) {
  const cad = normalizeRoutineDays(args);
  if (cad.error || !cad.days) return '';
  const d = parseRoutineDays(cad.days);
  if (d === 'weekdays') return c.t('routine.weekdays');
  if (d === 'weekends') return c.t('routine.weekends');
  if (Array.isArray(d)) {
    if (d.length === 7) return c.t('routine.every_day');
    const days = joinList(d.map((n) => c.t(`routine.dow_${n}`)), c);
    return c.t(d[0] === 0 || d[0] === 6 ? 'routine.on_days_from_weekend' : 'routine.on_days', { days });
  }
  if (d && typeof d === 'object' && Array.isArray(d.mes)) {
    const days = joinList(d.mes.map((n) => (n === -1 ? c.t('routine.last_day') : c.t('routine.day_n', { n }))), c);
    // Says what happens when the day doesn't exist in the month, otherwise the
    // owner confirms "day 31" thinking February gets nothing.
    return c.t('routine.monthly', { days, short: c.clause(d.mes.some((n) => n > 28), 'routine.short_months') });
  }
  if (d && typeof d === 'object' && Array.isArray(d.dow)) {
    return c.t('routine.nth_weekday', { ord: c.t(d.nth === -1 ? 'routine.ord_last' : `routine.ord_${d.nth}`), day: c.t(`routine.dow_${d.dow[0]}`) });
  }
  return c.t('routine.every_day');
}

function routineInterval(min, c) {
  const m = Number(min);
  if (m % 1440 === 0) return c.t('routine.interval_days', { count: m / 1440 });
  if (m % 60 === 0) return c.t('routine.interval_hours', { count: m / 60 });
  return c.t('routine.interval_minutes', { n: m });
}

// The full cadence. A routine runs either every N minutes or at a time on
// some days, and the card has to describe the mode that will be created.
function routineCadence(args, c) {
  const n = Number(args.repetir_cada_min);
  if (Number.isFinite(n) && n > 0) {
    const until = args.repetir_ate ? c.t('routine.until', { date: args.repetir_ate }) : c.t('routine.no_end');
    return c.t('routine.every_interval', { interval: routineInterval(n, c), until });
  }
  const sep = c.t('routine.time_separator');
  const time = routineArgsTimeLabel(args, sep) || c.t('routine.default_time', { time: routineTimeLabel(7, 0, sep) });
  return c.t('routine.days_at_time', { days: routineDays(args, c) || c.t('routine.every_day'), time });
}

// Fields of an Infinity item as the model sent them, on one line: the card
// shows every value that will be saved.
function infinityFields(fields) {
  if (!fields || typeof fields !== 'object') return '';
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v)}`)
    .join('; ');
}

const fixed = (tool) => ({ request: (a, c) => c.t(`${tool}.request`), done: (a, c) => c.t(`${tool}.done`) });
// "update the existing file ..." when the tool overwrites, keeping the link.
const overwrite = (tool, a) => `${tool}.${a.overwrite === true ? 'request_overwrite' : 'request'}`;
const onedrive = {
  request: (a, c) => c.t('onedrive_upload.request', { name: c.or(a.nome, 'common.no_name_q') }),
  done: (a, c) => c.t('onedrive_upload.done', { name: c.or(a.nome, 'common.no_name') }),
};

// Same variables in the request and the done sentence.
const simple = (tool, vars) => ({
  request: (a, c) => c.t(`${tool}.request`, vars(a, c)),
  done: (a, c) => c.t(`${tool}.done`, vars(a, c)),
});

// Per tool: request(args, c) and done(args, c). A tool missing here falls back
// to the generic frame sentence.
const SENTENCES = {
  gmail_send: email('gmail_send'),
  hotmail_send: email('hotmail_send'),
  falar_com_agente: {
    request: (a, c) => c.t('falar_com_agente.request', { contact: c.q(a.contato, 'common.the_contact'), goal: c.q(a.objetivo, 'common.no_goal') }),
    done: (a, c) => c.t('falar_com_agente.done', { contact: c.q(a.contato, 'common.the_contact') }),
  },
  // Gate tools (2026-09-28 audit: they wrote or sent on the model's decision alone).
  responder_pergunta_externa: {
    request: (a, c) => c.t('responder_pergunta_externa.request', { contact: c.q(a.para, 'common.the_contact'), answer: c.q(a.resposta) }),
    done: (a, c) => c.t('responder_pergunta_externa.done', { contact: c.q(a.para, 'common.the_contact') }),
  },
  aceitar_contato: simple('aceitar_contato', (a, c) => ({ contact: c.q(a.de, 'common.the_contact') })),
  recusar_contato: simple('recusar_contato', (a, c) => ({ contact: c.q(a.de || a.email, 'common.the_contact') })),
  convidar_contato: {
    request: (a, c) => c.t('convidar_contato.request', { email: c.q(a.email, 'common.no_email') }),
    done: (a, c) => c.t('convidar_contato.done', { email: c.q(a.email) }),
  },
  anotar_no_espaco: {
    request: (a, c) => c.t('anotar_no_espaco.request', { space: c.q(a.espaco), note: c.q(a.nota) }),
    done: (a, c) => c.t('anotar_no_espaco.done', { space: c.q(a.espaco) }),
  },
  configurar_espaco: {
    request: (a, c) => c.t('configurar_espaco.request', { space: c.q(a.espaco), mode: c.clause(a.modo, 'configurar_espaco.with_mode', { mode: a.modo }) }),
    done: (a, c) => c.t('configurar_espaco.done', { space: c.q(a.espaco) }),
  },
  editar_nota: {
    request: (a, c) => c.t('editar_nota.request', { id: c.q(a.nota_id, 'common.unknown'), space: c.q(a.espaco), note: c.q(a.nova_nota) }),
    done: (a, c) => c.t('editar_nota.done', { space: c.q(a.espaco) }),
  },
  apagar_nota: {
    request: (a, c) => c.t('apagar_nota.request', { id: c.q(a.nota_id, 'common.unknown'), space: c.q(a.espaco) }),
    done: (a, c) => c.t('apagar_nota.done', { space: c.q(a.espaco) }),
  },
  sair_do_espaco: simple('sair_do_espaco', (a, c) => ({ space: c.q(a.espaco) })),
  remover_do_espaco: {
    request: (a, c) => c.t('remover_do_espaco.request', { contact: c.q(a.contato, 'common.the_contact'), space: c.q(a.espaco) }),
    done: (a, c) => c.t('remover_do_espaco.done', { contact: c.q(a.contato, 'common.the_contact_cap'), space: c.q(a.espaco) }),
  },
  editar_skill: {
    request: (a, c) => c.t('editar_skill.request', { skill: c.q(a.skill), script: c.clause(a.script, 'editar_skill.with_script') }),
    done: (a, c) => c.t('editar_skill.done', { skill: c.q(a.nome || a.skill) }),
  },
  apagar_skill: simple('apagar_skill', (a, c) => ({ skill: c.q(a.skill) })),
  desinstalar_skill: {
    request: (a, c) => c.t('desinstalar_skill.request', { skill: c.q(a.skill), from: c.clause(a.de, 'desinstalar_skill.from_author', { author: a.de }) }),
    done: (a, c) => c.t('desinstalar_skill.done', { skill: c.q(a.skill) }),
  },
  remover_colaborador: {
    request: (a, c) => c.t('remover_colaborador.request', { contact: c.q(a.contato, 'common.the_contact'), app: c.q(a.nome_do_sistema) }),
    done: (a, c) => c.t('remover_colaborador.done', { contact: c.q(a.contato, 'common.the_contact_cap'), app: c.q(a.nome_do_sistema) }),
  },
  definir_visibilidade_sistema: {
    request: (a, c) => c.t('definir_visibilidade_sistema.request', { app: c.q(a.nome_do_sistema), visibility: c.q(a.visibilidade, 'common.unknown') }),
    done: (a, c) => c.t('definir_visibilidade_sistema.done', { app: c.q(a.nome_do_sistema), visibility: c.q(a.visibilidade) }),
  },
  definir_acesso_sistema: {
    request: (a, c) => (a.acesso === 'publico'
      ? c.t('definir_acesso_sistema.request_public', { app: c.q(a.nome_do_sistema) })
      : c.t('definir_acesso_sistema.request_locked', { app: c.q(a.nome_do_sistema), password: c.clause(a.nova_senha, 'definir_acesso_sistema.new_password') })),
    done: (a, c) => c.t(`definir_acesso_sistema.${a.acesso === 'publico' ? 'done_public' : 'done_locked'}`, { app: c.q(a.nome_do_sistema) }),
  },
  remover_da_home: {
    request: (a, c) => c.t('remover_da_home.request', { id: c.q(a.id, 'common.unknown') }),
    done: (a, c) => c.t('remover_da_home.done', { id: c.q(a.id) }),
  },
  parar_sistema: simple('parar_sistema', (a, c) => ({ app: c.q(a.nome_do_sistema) })),
  reiniciar_sistema: simple('reiniciar_sistema', (a, c) => ({ app: c.q(a.nome_do_sistema) })),
  enviar_midia_para_sistema: simple('enviar_midia_para_sistema', (a, c) => ({
    media: c.q(a.id_midia, 'common.unknown'), method: a.metodo ?? 'POST', route: c.q(a.rota, 'common.unknown'), app: c.q(a.nome_do_sistema),
  })),
  gmail_label_create: simple('gmail_label_create', (a, c) => ({ label: c.q(a.nome) })),
  gmail_label_update: simple('gmail_label_update', (a, c) => ({ label: c.q(a.marcador), new_name: c.q(a.novo_nome) })),
  configurar_deploy: simple('configurar_deploy', (a, c) => ({
    host: c.clause(a.host, 'configurar_deploy.to_host', { host: `${a.usuario ? `${a.usuario}@` : ''}${a.host}` }),
    command: c.clause(a.comando, 'configurar_deploy.running', { command: a.comando }),
  })),
  cancelar_rotina: simple('cancelar_rotina', (a, c) => ({ routine: a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${c.q(a.titulo)}"` })),
  remover_evento: {
    request: (a, c) => c.t('remover_evento.request', { date: c.q(a.data, 'common.date_unknown'), tracker: c.q(a.tracker) }),
    done: (a, c) => c.t('remover_evento.done', { tracker: c.q(a.tracker) }),
  },
  remover_tracker: simple('remover_tracker', (a, c) => ({ tracker: c.q(a.tracker) })),
  remover_monitor: simple('remover_monitor', (a, c) => ({ monitor: c.q(a.monitor) })),
  definir_modo_permissao: {
    request: (a, c) => c.t('definir_modo_permissao.request', { mode: c.q(a.modo, 'common.unknown'), effect: c.clause(a.modo === 'aceitar_edicoes', 'definir_modo_permissao.accept_edits') }),
    done: (a, c) => c.t('definir_modo_permissao.done', { mode: c.q(a.modo) }),
  },
  gmail_label_delete: {
    request: (a, c) => c.t('gmail_label_delete.request', { label: c.or(a.marcador, 'common.unknown') }),
    done: (a, c) => c.t('gmail_label_delete.done', { label: a.marcador || '' }),
  },
  gmail_filter_create: {
    request: (a, c) => {
      const k = (key, value) => c.t(`gmail_filter_create.${key}`, { value });
      const criteria = [a.de && k('from', a.de), a.para && k('to', a.para), a.assunto && k('subject', a.assunto), a.contem && k('containing', a.contem), a.tem_anexo && k('has_attachment')].filter(Boolean).join(', ');
      const actions = [a.marcador && k('label', a.marcador), a.pular_caixa_entrada && k('skip_inbox'), a.marcar_lido && k('mark_read'), a.marcar_importante && k('mark_important')].filter(Boolean).join(', ');
      return c.t('gmail_filter_create.request', { criteria: criteria || k('no_criteria'), actions: actions || k('no_action') });
    },
    done: (a, c) => c.t('gmail_filter_create.done'),
  },
  gmail_filter_delete: fixed('gmail_filter_delete'),
  calendar_create: {
    request: (a, c) => c.t('calendar_create.request', { title: c.or(a.summary || a.title, 'common.no_title_q'), when: c.clause(a.start, 'event.on_date', { date: a.start }) }),
    done: (a, c) => {
      const w = when(a.start, c.lang);
      return c.t('calendar_create.done', { title: c.or(a.summary || a.title, 'common.no_title'), when: c.clause(w, 'event.for_date', { date: `${w}${a.timezone ? ` (${a.timezone})` : ''}` }) });
    },
  },
  calendar_update: {
    request: (a, c) => c.t('calendar_update.request', { changes: eventChanges(a, c, GOOGLE_EVENT, 'request') }),
    done: (a, c) => c.t('calendar_update.done', { changes: eventChanges(a, c, GOOGLE_EVENT, 'done') }),
  },
  calendar_delete: fixed('calendar_delete'),
  outlook_calendar_create: {
    request: (a, c) => c.t('outlook_calendar_create.request', { title: c.or(a.titulo, 'common.no_title_q'), when: c.clause(a.inicio, 'event.on_date', { date: when(a.inicio, c.lang) }) }),
    done: (a, c) => {
      const w = when(a.inicio, c.lang);
      return c.t('outlook_calendar_create.done', { title: c.or(a.titulo, 'common.no_title'), when: c.clause(w, 'event.for_date', { date: w }) });
    },
  },
  outlook_calendar_update: {
    request: (a, c) => c.t('outlook_calendar_update.request', { changes: eventChanges(a, c, OUTLOOK_EVENT, 'request') }),
    done: (a, c) => c.t('outlook_calendar_update.done', { changes: eventChanges(a, c, OUTLOOK_EVENT, 'done') }),
  },
  outlook_calendar_delete: fixed('outlook_calendar_delete'),
  drive_upload: {
    request: (a, c) => c.t('drive_upload.request', { name: c.or(a.name || a.filename, 'common.no_name_q') }),
    done: (a, c) => c.t('drive_upload.done', { name: c.or(a.name || a.filename, 'common.no_name') }),
  },
  drive_upload_arquivo: {
    request: (a, c) => c.t(overwrite('drive_upload_arquivo', a), { name: c.or(a.nome, 'common.no_name_q') }),
    done: (a, c) => c.t('drive_upload_arquivo.done', { name: c.or(a.nome, 'common.no_name') }),
  },
  enviar_para_drive: {
    request: (a, c) => c.t(overwrite('enviar_para_drive', a), { name: c.clause(a.nome, 'enviar_para_drive.named', { name: a.nome }) }),
    done: (a, c) => c.t('enviar_para_drive.done', { name: c.clause(a.nome, 'enviar_para_drive.copy_of', { name: a.nome }) }),
  },
  docs_create: {
    request: (a, c) => c.t(overwrite('docs_create', a), { name: c.or(a.name, 'common.no_name_q') }),
    done: (a, c) => c.t('docs_create.done', { name: c.or(a.name, 'common.no_name') }),
  },
  drive_export_pdf: {
    request: (a, c) => c.t('drive_export_pdf.request', { as: c.clause(a.name, 'drive_export_pdf.as_name', { name: String(a.name).replace(/\.pdf$/i, '') }) }),
    done: (a, c) => c.t('drive_export_pdf.done'),
  },
  onedrive_upload: onedrive,
  onedrive_upload_arquivo: onedrive,
  github_create_issue: {
    request: (a, c) => c.t('github_create_issue.request', { repo: c.clause(a.repo, 'github_create_issue.in_repo', { repo: a.repo }), title: a.title || '' }),
    done: (a, c) => c.t('github_create_issue.done', { repo: c.clause(a.repo, 'github_create_issue.in_repo', { repo: a.repo }), title: a.title || '' }),
  },
  github_comment_issue: {
    request: (a, c) => c.t('github_comment_issue.request', { repo: a.repo || '', number: String(a.number ?? a.issue ?? '') }),
    done: (a, c) => c.t('github_comment_issue.done', { repo: a.repo || '', number: String(a.number ?? a.issue ?? '') }),
  },
  slack_post_message: {
    request: (a, c) => c.t('slack_post_message.request', { channel: c.clause(a.channel, 'slack_post_message.in_channel', { channel: a.channel }) }),
    done: (a, c) => c.t('slack_post_message.done', { channel: c.clause(a.channel, 'slack_post_message.in_channel', { channel: a.channel }) }),
  },
  linkedin_post: {
    request: (a, c) => c.t('linkedin_post.request', {
      audience: c.t(a.visibility === 'CONNECTIONS' ? 'linkedin_post.connections' : 'linkedin_post.public'),
      text: String(a.text || '').slice(0, 280),
      link: c.clause(a.link, 'linkedin_post.with_link', { link: a.link }),
    }),
    done: (a, c) => c.t('linkedin_post.done'),
  },
  confirmar_com_agente: {
    request: (a, c) => c.t('confirmar_com_agente.request', { contact: c.or(a.contato, 'common.contact_unknown'), decision: a.decisao || '' }),
    done: (a, c) => c.t('confirmar_com_agente.done', { contact: c.or(a.contato, 'common.your_contact') }),
  },
  responder_decisao: {
    request: (a, c) => c.t(`responder_decisao.${a.aceito ? 'request_accept' : 'request_decline'}`, {
      from: c.clause(a.de, 'responder_decisao.from_contact', { from: a.de }),
      message: c.clause(a.mensagem, 'responder_decisao.with_message', { message: a.mensagem }),
    }),
    done: (a, c) => c.t(`responder_decisao.${a.aceito ? 'done_accept' : 'done_decline'}`),
  },
  rodar_no_servidor: runCommand,
  rodar_comando: runCommand,
  editar_arquivo: hostFile('editar_arquivo'),
  escrever_arquivo: hostFile('escrever_arquivo'),
  git_commit: {
    request: (a, c) => c.t('git_commit.request', { dir: inDir(a, c), message: a.mensagem || '', staged: c.t(a.adicionar_tudo === false ? 'git_commit.only_staged' : 'git_commit.add_all') }),
    done: (a, c) => c.t('git_commit.done', { dir: inDir(a, c), message: a.mensagem || '' }),
  },
  git_push: {
    request: (a, c) => c.t('git_push.request', { branch: pushBranch(a, c), remote: a.remote || 'origin', dir: c.clause(a.diretorio, 'git_push.dir', { dir: a.diretorio }) }),
    done: (a, c) => c.t('git_push.done', { branch: pushBranch(a, c), remote: a.remote || 'origin' }),
  },
  git_branch: {
    request: (a, c) => c.t('git_branch.request', { name: a.nome || '', base: c.clause(a.base, 'git_branch.from_base', { base: a.base }), dir: inDir(a, c) }),
    done: (a, c) => c.t('git_branch.done', { name: a.nome || '' }),
  },
  git_checkout: {
    request: (a, c) => c.t('git_checkout.request', { ref: a.ref || '', dir: inDir(a, c) }),
    done: (a, c) => c.t('git_checkout.done', { ref: a.ref || '' }),
  },
  gerenciar_tarefa_de_app: {
    request: (a, c) => {
      const app = c.or(a.app, 'gerenciar_tarefa_de_app.default_app');
      if (a.acao === 'cancelar') return c.t('gerenciar_tarefa_de_app.request_cancel', { app });
      if (a.acao === 'resolver_pendencia') return c.t(a.resultado === 'concluida'
        ? 'gerenciar_tarefa_de_app.request_resolve_done'
        : 'gerenciar_tarefa_de_app.request_resolve_not_done', { app });
      return c.t('gerenciar_tarefa_de_app.request', {
        app,
        mode: c.t(a.modo === 'edicao' ? 'gerenciar_tarefa_de_app.mode_edit' : 'gerenciar_tarefa_de_app.mode_review'),
        goal: String(a.objetivo || '').replace(/[<>\r\n]/g, ' ').slice(0, 2000),
      });
    },
    done: (a, c) => c.t(a.acao === 'cancelar' ? 'gerenciar_tarefa_de_app.done_cancel'
      : a.acao === 'resolver_pendencia' ? (a.resultado === 'concluida' ? 'gerenciar_tarefa_de_app.done_resolve_done' : 'gerenciar_tarefa_de_app.done_resolve_not_done')
      : 'gerenciar_tarefa_de_app.done'),
  },
  publicar_sistema: {
    request: (a, c) => (a.dono
      ? c.t('publicar_sistema.request_collab', { app: c.or(a.nome_do_sistema, 'common.no_name_q'), owner: a.dono })
      : c.t('publicar_sistema.request', { app: c.or(a.nome_do_sistema, 'common.no_name_q'), runtime: a.runtime || '?' })),
    done: (a, c) => c.t('publicar_sistema.done', { app: a.nome_do_sistema || '' }),
  },
  criar_rotina: {
    request: (a, c) => c.t('criar_rotina.request', {
      title: c.or(a.titulo, 'common.no_title_q'), cadence: routineCadence(a, c),
      channel: c.clause(a.canal, isAppOnly(a.canal) ? 'criar_rotina.request_channel_app' : 'criar_rotina.request_channel', { channel: a.canal }),
    }),
    done: (a, c) => c.t('criar_rotina.done', {
      title: c.or(a.titulo, 'common.no_title'), cadence: routineCadence(a, c),
      channel: c.clause(a.canal, isAppOnly(a.canal) ? 'criar_rotina.done_channel_app' : 'criar_rotina.done_channel', { channel: a.canal }),
    }),
  },
  editar_rotina: {
    request: (a, c) => {
      const parts = [];
      if (a.ativa !== undefined) parts.push(c.t(a.ativa ? 'editar_rotina.resume' : 'editar_rotina.pause'));
      if (a.novo_titulo) parts.push(c.t('editar_rotina.rename', { title: a.novo_titulo }));
      if (a.canal) parts.push(c.t(isAppOnly(a.canal) ? 'editar_rotina.channel_app' : 'editar_rotina.channel', { channel: a.canal }));
      const time = routineArgsTimeLabel(a, c.t('routine.time_separator'));
      if (time) parts.push(c.t(time.startsWith(':') ? 'editar_rotina.at_minute' : 'editar_rotina.at_time', { time }));
      const days = routineDays(a, c);
      if (days) parts.push(days);
      if (a.o_que_fazer) parts.push(c.t('editar_rotina.change_task'));
      if (a.testar_agora === true) parts.push(c.t('editar_rotina.test_now'));
      // The routine may come by its code (#xxxx) instead of its title, when the
      // owner has two with the same name; then the code goes in the question.
      const target = a.titulo ? `"${a.titulo}"` : a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${c.t('common.no_title_q')}"`;
      return c.t('editar_rotina.request', { target, changes: c.clause(parts.length, 'editar_rotina.changes', { list: parts.join(', ') }) });
    },
    done: (a, c) => c.t('editar_rotina.done', {
      target: a.novo_titulo || a.titulo ? `"${a.novo_titulo || a.titulo}"` : `#${String(a.id || '').replace(/^#/, '')}`,
    }),
  },
  convidar_colaborador: {
    request: (a, c) => c.t('convidar_colaborador.request', { contact: c.or(a.contato, 'common.contact_unknown'), name: c.or(a.nome_do_sistema, 'common.no_name_q') }),
    done: (a, c) => c.t('convidar_colaborador.done', { contact: c.or(a.contato, 'common.the_contact_cap'), name: a.nome_do_sistema || '' }),
  },
  convidar_para_espaco: {
    request: (a, c) => c.t('convidar_para_espaco.request', { contact: c.or(a.contato, 'common.contact_unknown'), space: c.or(a.espaco, 'common.no_name_q') }),
    done: (a, c) => c.t('convidar_para_espaco.done', { contact: c.or(a.contato, 'common.the_contact_cap'), space: a.espaco || '' }),
  },
  instalar_skill: {
    request: (a, c) => c.t('instalar_skill.request', { skill: c.or(a.skill, 'common.no_name_q'), from: c.clause(a.de, 'instalar_skill.from', { from: a.de }) }),
    done: (a, c) => c.t('instalar_skill.done', { skill: a.skill || '', from: c.clause(a.de, 'instalar_skill.from', { from: a.de }) }),
  },
  compartilhar_skill: {
    request: (a, c) => c.t('compartilhar_skill.request', { skill: c.or(a.skill, 'common.no_name_q'), contact: c.or(a.contato, 'common.contact_unknown') }),
    done: (a, c) => c.t('compartilhar_skill.done', { skill: a.skill || '', contact: c.or(a.contato, 'common.the_contact') }),
  },
  rodar_skill: {
    request: (a, c) => c.t('rodar_skill.request', { skill: c.or(a.skill, 'common.no_name_q'), argument: c.clause(a.argumento, 'rodar_skill.with_argument', { argument: a.argumento }) }),
    done: (a, c) => c.t('rodar_skill.done', { skill: a.skill || '' }),
  },
  // Canva: the card shows the FULL objective, because that is what the
  // sub-agent will execute; a summary would hide the text being authorized.
  canva_criar: { request: (a, c) => c.t('canva_criar.request', { goal: c.or(a.objetivo, 'common.no_goal') }), done: (a, c) => c.t('canva_criar.done') },
  canva_editar: { request: (a, c) => c.t('canva_editar.request', { goal: c.or(a.objetivo, 'common.no_goal') }), done: (a, c) => c.t('canva_editar.done') },
  notion_create_page: {
    request: (a, c) => c.t('notion_create_page.request', { title: c.or(a.titulo, 'common.no_title_q') }),
    done: (a, c) => c.t('notion_create_page.done', { title: a.titulo || '' }),
  },
  notion_append: fixed('notion_append'),
  infinity_criar_item: {
    request: (a, c) => {
      const fields = infinityFields(a.campos);
      return c.t('infinity_criar_item.request', { board: a.board_id || '?', folder: a.folder_id || '?', fields: c.clause(fields, 'infinity_criar_item.with_fields', { fields }) });
    },
    done: (a, c) => c.t('infinity_criar_item.done'),
  },
  infinity_editar_item: {
    request: (a, c) => {
      const fields = infinityFields(a.campos);
      return c.t('infinity_editar_item.request', {
        item: a.item_id || '?', fields: c.clause(fields, 'infinity_editar_item.fields', { fields }),
        folder: c.clause(a.folder_id, 'infinity_editar_item.move_to', { folder: a.folder_id }),
      });
    },
    done: (a, c) => c.t('infinity_editar_item.done'),
  },
  infinity_comentar: {
    request: (a, c) => c.t('infinity_comentar.request', { item: a.item_id || '?', text: a.texto || '' }),
    done: (a, c) => c.t('infinity_comentar.done'),
  },
  splitwise_add_expense: {
    request: (a, c) => c.t('splitwise_add_expense.request', { description: c.or(a.descricao, 'common.no_description'), currency: a.moeda || 'BRL', amount: c.q(a.valor) || '?' }),
    done: (a, c) => c.t('splitwise_add_expense.done', { description: a.descricao || '', currency: a.moeda || 'BRL', amount: c.q(a.valor) }),
  },
  asaas_receber_pix: {
    request: (a, c) => (a.valor != null ? c.t('asaas_receber_pix.request_amount', { amount: a.valor }) : c.t('asaas_receber_pix.request')),
    done: (a, c) => c.t('asaas_receber_pix.done'),
  },
  asaas_pagar_conta: {
    request: (a, c) => c.t('asaas_pagar_conta.request', {
      amount: a.valor != null ? c.t('asaas_pagar_conta.amount', { amount: a.valor }) : c.t('asaas_pagar_conta.own_amount'),
      line: a.linha_digitavel || a.codigo_de_barras || c.t('common.unknown'),
      scheduled: c.clause(a.agendar_para, 'asaas_pagar_conta.scheduled', { date: a.agendar_para }),
    }),
    done: (a, c) => c.t('asaas_pagar_conta.done', {
      amount: c.clause(a.valor != null, 'asaas_pagar_conta.done_amount', { amount: a.valor }),
      scheduled: c.clause(a.agendar_para, 'asaas_pagar_conta.done_scheduled', { date: a.agendar_para }),
    }),
  },
  asaas_cancelar_pagamento_conta: {
    request: (a, c) => c.t('asaas_cancelar_pagamento_conta.request', { id: c.or(a.id, 'asaas_cancelar_pagamento_conta.no_id') }),
    done: (a, c) => c.t('asaas_cancelar_pagamento_conta.done'),
  },
  asaas_transferir_pix: {
    request: (a, c) => c.t('asaas_transferir_pix.request', {
      amount: c.q(a.valor) || '?', key: c.or(a.chave_pix, 'common.unknown'), key_type: a.tipo_chave || '?',
      scheduled: c.clause(a.agendar_para, 'asaas_transferir_pix.scheduled', { date: a.agendar_para }),
    }),
    done: (a, c) => c.t('asaas_transferir_pix.done', {
      amount: c.q(a.valor), key: a.chave_pix || '',
      scheduled: c.clause(a.agendar_para, 'asaas_transferir_pix.done_scheduled', { date: a.agendar_para }),
    }),
  },
  asaas_enviar_comprovante_email: {
    request: (a, c) => c.t('asaas_enviar_comprovante_email.request', { to: c.or(a.para, 'common.recipient_unknown'), id: c.or(a.id, 'common.unknown') }),
    done: (a, c) => c.t('asaas_enviar_comprovante_email.done', { to: c.or(a.para, 'common.the_recipient') }),
  },
  salvar_credencial: {
    request: (a, c) => c.t('salvar_credencial.request', { service: c.or(a.servico, 'salvar_credencial.service_unknown') }),
    done: (a, c) => c.t('salvar_credencial.done', { service: c.or(a.servico, 'salvar_credencial.service') }),
  },
  // The owner sees exactly the data the account will be opened with: their tax
  // ID goes to a credit review that can't be undone. The sentence also carries
  // the mandatory disclosure that the partner payment institution issues it.
  criar_conta_brambs: {
    request: (a, c) => c.t('criar_conta_brambs.request', {
      brand_upper: marca().nome.toUpperCase(), brand: marca().nome,
      name: a.nome || '(?)', tax_id: a.cpf_cnpj || '(?)', email: a.email || '(?)', phone: a.celular || '(?)',
      street: a.endereco || '(?)', number: a.numero || '(?)', complement: a.complemento ? ` ${a.complemento}` : '',
      district: a.bairro || '(?)', zip: a.cep || '(?)', income: c.q(a.renda_mensal) || '(?)',
    }),
    done: (a, c) => c.t('criar_conta_brambs.done', { brand: marca().nome }),
  },
  // Depends on the CART, not the args: the amount approved is the one of the
  // cart built at the store, never a number repeated by the model.
  fechar_pedido: {
    request: (a, c) => {
      const summary = descreverCarrinho(a.carrinho_id);
      if (!summary) return c.t('fechar_pedido.request_no_cart');
      // Outside VTEX the store doesn't let us close the sale: payment happens on
      // its own screen, so "create a real order" would promise something false.
      if (plataformaDoCarrinho(a.carrinho_id) !== 'vtex') return c.t('fechar_pedido.request_external', { summary });
      return c.t('fechar_pedido.request', { summary });
    },
    done: (a, c) => c.t('fechar_pedido.done'),
  },
  apagar_sistema: {
    request: (a, c) => c.t('apagar_sistema.request', { name: c.or(a.nome_do_sistema, 'common.no_name_q') }),
    done: (a, c) => c.t('apagar_sistema.done', { name: a.nome_do_sistema || '' }),
  },
  replicar_sistema: {
    request: (a, c) => c.t('replicar_sistema.request', { source: c.or(a.origem, 'replicar_sistema.source_unknown'), new_name: c.clause(a.novo_nome, 'replicar_sistema.as_name', { name: a.novo_nome }) }),
    done: (a, c) => c.t('replicar_sistema.done', { new_name: c.clause(a.novo_nome, 'replicar_sistema.as_name', { name: a.novo_nome }) }),
  },
  voltar_versao: {
    request: (a, c) => c.t('voltar_versao.request', { name: c.or(a.nome_do_sistema, 'common.no_name_q'), version: c.or(a.versao, 'common.unknown') }),
    done: (a, c) => c.t('voltar_versao.done', { name: a.nome_do_sistema || '', version: a.versao || '' }),
  },
  remover_arquivo_do_app: {
    request: (a, c) => c.t('remover_arquivo_do_app.request', { path: c.or(a.caminho, 'common.unknown'), name: c.or(a.nome_do_sistema, 'common.no_name_q') }),
    done: (a, c) => c.t('remover_arquivo_do_app.done', { path: c.or(a.caminho, 'common.unknown'), name: a.nome_do_sistema || '' }),
  },
  remover_segredo: {
    request: (a, c) => c.t('remover_segredo.request', { key: c.or(a.chave, 'common.unknown'), name: c.or(a.nome_do_sistema, 'common.no_name_q') }),
    done: (a, c) => c.t('remover_segredo.done', { key: c.or(a.chave, 'common.unknown'), name: a.nome_do_sistema || '' }),
  },
  // The journey's own texts (the proposal, finishing, retrying) are built by
  // the discovery module in the person's language; the card only quotes them.
  jornada_configurar: { request: (a, c) => configurationLabel(a, c.lang), done: (a, c) => c.t('jornada_configurar.done') },
  jornada_concluir: { request: (a, c) => completionLabel(c.lang), done: (a, c) => c.t('jornada_concluir.done', { brand: marca().nome }) },
  jornada_refazer_devolutiva: { request: (a, c) => retryLabel(c.lang), done: (a, c) => c.t('jornada_refazer_devolutiva.done') },
  jornada_editar_nota: {
    request: (a, c) => (a.action === 'delete'
      ? c.t('jornada_editar_nota.request_delete')
      : c.t('jornada_editar_nota.request_fix', { text: c.or(a.text, 'jornada_editar_nota.text_missing') })),
    done: (a, c) => c.t('jornada_editar_nota.done'),
  },
  permitir_comando: {
    request: (a, c) => c.t('permitir_comando.request', { prefix: c.q(a.prefixo, 'common.unknown') }),
    done: (a, c) => c.t('permitir_comando.done', { prefix: c.q(a.prefixo) }),
  },
};

// Whether a tool has sentences of its own (the gate test demands one per tool).
export const hasSentence = (name) => Object.hasOwn(SENTENCES, name);

// Card date: the wall-clock time as it came, in the reader's format.
export { when as cardDate };

// A tool with no sentence of its own gets the generic one, which names it:
// the gate never shows an empty card.
export function requestSentence(name, args, lang) {
  const c = context(lang);
  const f = SENTENCES[name]?.request;
  return f ? f(args || {}, c) : c.t('common.generic_request', { name });
}

export function doneSentence(name, args, lang) {
  const c = context(lang);
  const f = SENTENCES[name]?.done;
  return f ? f(args || {}, c) : c.t('common.generic_done', { name });
}

// The frame renderConfirmed builds around the sentence: failure header,
// pending states, Pix data, calendar and app access lines.
export function frameText(key, vars, lang) {
  return context(lang).t(`frame.${key}`, vars);
}

// Amount with two decimals and no thousands separator, in the reader's format.
export function cardAmount(value, lang) {
  return new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(Number(value));
}

// A date-only ISO string (YYYY-MM-DD) in the reader's format, with no time zone shift.
export function cardDay(iso, lang) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Intl.DateTimeFormat(lang, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(Date.UTC(year, month - 1, day));
}
