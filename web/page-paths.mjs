// Paths of the app's pages. They are in English whatever the person's language;
// the Portuguese paths they had before answer with a permanent redirect so links
// already sent (e-mails, messages, bookmarks, the phone app) keep working.

// Logged-in area: one URL per menu section. All require a session.
export const APP_PAGES = new Set(['/chats', '/new', '/assistants', '/memory', '/skills-and-apps', '/connections',
  '/contacts', '/files', '/credits', '/settings']);

// The owner's screen for the assistants that answer the public (web/public/public-support.html).
export const PUBLIC_SUPPORT_PAGE = '/public-support';

const MOVED = new Map([
  ['/inicio', '/chats'], ['/conversas', '/chats'], ['/nova', '/new'], ['/assistentes', '/assistants'],
  ['/memoria', '/memory'], ['/habilidades-apps', '/skills-and-apps'], ['/conexoes', '/connections'],
  ['/contatos', '/contacts'], ['/arquivos', '/files'], ['/creditos', '/credits'], ['/config', '/settings'],
  ['/atendimento', PUBLIC_SUPPORT_PAGE], ['/atendimento.html', PUBLIC_SUPPORT_PAGE],
]);

// New path for an old page path (GET/HEAD only), or null. The caller keeps the query.
export function movedPagePath(method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  return MOVED.get(pathname) ?? null;
}
