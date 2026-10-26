// The installation's public-support text on /admin/settings: the rules every
// public assistant of this installation follows (INSTALLATION_PROMPT_DEFAULT in
// public-support.mjs, edits and history in public-support-prompts.mjs). Only the
// administrator (ADMIN_EMAIL) reaches these routes; anyone else gets a 404, and
// so does everyone when public support is off for the installation.
import { readBody } from './http-body.mjs';
import { SEGUE } from './routes.mjs';
import { adminUser } from './admin-user.mjs';
import { INSTALLATION_PROMPT_DEFAULT } from './public-support.mjs';
import { PROMPT_MAX, asEdit, textState } from './public-support-prompts.mjs';

export const INSTALLATION_PROMPT_PATH = '/api/admin/public-support/installation-prompt';

const reply = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

export function registerPublicSupportAdmin({ rotas, prompts, defaultText = INSTALLATION_PROMPT_DEFAULT }) {
  const key = (user) => ({ kind: 'installation', userId: user.id });
  const route = (method, path, handle) => rotas.registrar(method, path, async (req, res, url, ctx) => {
    const user = await adminUser(ctx);
    if (!user) return SEGUE;
    try { return await handle({ req, res, user }); }
    catch (e) { console.error('[public-support-admin] failed:', e?.code ?? e?.name ?? 'error'); return reply(res, 500, { error: 'save_failed' }); }
  });

  route('GET', INSTALLATION_PROMPT_PATH, async ({ res, user }) => reply(res, 200, await textState(prompts, key(user), defaultText)));

  // { content }: '' or the default itself = back to the default.
  route('POST', INSTALLATION_PROMPT_PATH, async ({ req, res, user }) => {
    const body = await readBody(req).catch(() => null);
    if (typeof body?.content !== 'string') return reply(res, 400, { error: 'bad_request' });
    if (body.content.trim().length > PROMPT_MAX) return reply(res, 400, { error: 'too_long', max: PROMPT_MAX });
    await prompts.save({ ...key(user), content: asEdit(body.content, defaultText) });
    return reply(res, 200, await textState(prompts, key(user), defaultText));
  });

  route('POST', INSTALLATION_PROMPT_PATH + '/restore', async ({ req, res, user }) => {
    const body = await readBody(req).catch(() => null);
    if (!(await prompts.restore({ ...key(user), versionId: body?.versionId }))) return reply(res, 404, { error: 'not_found' });
    return reply(res, 200, await textState(prompts, key(user), defaultText));
  });
}
