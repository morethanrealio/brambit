import { recurrenceLabel } from './calendar-recurrence.mjs';
// Allowlisted adapters only. Never accept an arbitrary connector's claim that
// it produced evidence. Each contract names the actual provider response ID.
const definitions = {
  calendar_create: ['calendar', 'created', d => d.id, (a,d) => d.agenda || 'Google Calendar'],
  calendar_update: ['calendar', 'updated', d => d.id, (a,d) => d.agenda || 'Google Calendar'],
  calendar_delete: ['calendar', 'deleted', d => d.deletedId, (a,d) => d.agenda || 'Google Calendar'],
  outlook_calendar_create: ['calendar', 'created', d => d.evento?.id, () => 'Outlook Calendar'],
  outlook_calendar_update: ['calendar', 'updated', d => d.evento?.id, () => 'Outlook Calendar'],
  outlook_calendar_delete: ['calendar', 'deleted', d => d.deletedId, () => 'Outlook Calendar'],
  drive_upload: ['file', 'saved_file', d => d.id, () => 'Google Drive'],
  drive_upload_arquivo: ['file', 'saved_file', d => d.id, () => 'Google Drive'],
  docs_create: ['file', 'saved_file', d => d.id, () => 'Google Docs'],
  drive_export_pdf: ['file', 'saved_file', d => d.id, () => 'Google Drive'],
  enviar_para_drive: ['file', 'saved_file', d => d.id, () => 'Google Drive'],
  onedrive_upload: ['file', 'saved_file', d => d.id, () => 'OneDrive'],
  onedrive_upload_arquivo: ['file', 'saved_file', d => d.id, () => 'OneDrive'],
  gmail_label_create: ['mail_settings', 'created', d => d.id, () => 'Gmail'],
  gmail_label_update: ['mail_settings', 'updated', d => d.id, () => 'Gmail'],
  gmail_label_delete: ['mail_settings', 'deleted', d => d.apagado, () => 'Gmail'],
  gmail_filter_create: ['mail_settings', 'created', d => d.id, () => 'Gmail'],
  gmail_filter_delete: ['mail_settings', 'deleted', d => d.apagado, () => 'Gmail'],
  linkedin_post: ['post', 'commented', d => d.id, () => 'LinkedIn'],
  splitwise_add_expense: ['expense', 'created', d => d.id, () => 'Splitwise'],
  infinity_criar_item: ['item', 'created', d => d.id, () => 'Infinity'],
  infinity_editar_item: ['item', 'updated', d => d.id, () => 'Infinity'],
  infinity_comentar: ['comment', 'commented', d => d.id, () => 'Infinity'],
  notion_create_page: ['page', 'created', d => d.id, () => 'Notion'],
  notion_append: ['page', 'updated', d => d.id, () => 'Notion'],
  github_create_issue: ['issue', 'created', d => d.id, a => `${a.owner}/${a.repo}`],
  github_comment_issue: ['issue', 'commented', d => d.id, a => `${a.owner}/${a.repo} #${a.number}`],
  slack_post_message: ['message', 'accepted', d => d.ts, (a,d) => d.channel],
  hotmail_send: ['message', 'accepted', d => d.requestId, a => a.to],
};
// The Google Docs/Drive link opens the same without the query; it carries the
// owner's Google account ID (ouid) and internal parameters that have no reason
// to show up.
export function shareableLink(link) {
  if (typeof link !== 'string' || !/^https:\/\//.test(link)) return '';
  try {
    const u = new URL(link);
    if (['docs.google.com','drive.google.com'].includes(u.hostname)) { u.search = ''; u.hash = ''; }
    return u.toString();
  } catch { return ''; }
}
export function connectorActionReceipt(name, args = {}, data) {
  if (!args || typeof args !== 'object') args = {};
  const definition = definitions[name];
  if (!definition) return null;
  const [family, state, getId, getTarget] = definition;
  const base = { family, tool: name, state: 'unknown', subject: args.title || args.titulo || args.subject || args.name || args.nome || args.descricao || '' };
  if (data?.ok === false && !data.incerto) return { ...base, state: 'failed' };
  if (data?.ok !== true || data.skipped || data.incerto || data.pending) return base;
  const id = getId(data), target = getTarget(args,data);
  if (!((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id) && id > 0)) || !target) return base;
  if (/calendar_(update|delete)$/.test(name) && String(id) !== String(args.id)) return base;
  if (name === 'gmail_filter_delete' && String(id) !== String(args.id)) return base;
  if (name === 'notion_append' && (!data.blockIds?.length || data.blockIds.some(id => typeof id !== 'string' || !id.trim()))) return base;
  if (name === 'hotmail_send' && data.httpStatus !== 202) return base;
  const link = shareableLink(data.link || data.url);
  let at = args.start || args.inicio || '';
  if (family === 'calendar' && args.recorrencia) {
    try { at = recurrenceLabel(args.recorrencia,args.start || args.inicio,args.timezone || args.fuso); } catch { return base; }
  }
  return { ...base, state, id, target, ...(link ? { link } : {}),
    ...(family === 'calendar' && at ? {at} : {}),
    ...(family === 'calendar' && args.recorrencia ? {recurrence:{rule:args.recorrencia,start:args.start || args.inicio,timezone:args.timezone || args.fuso}} : {}),
    ...(data.partial ? { state: 'partial' } : {}) };
}
