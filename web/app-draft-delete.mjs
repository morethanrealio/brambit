// apagar_sistema for an app that was never published: there is no row in
// `apps` and no container, only the staged draft. Scoped to this user and
// system exactly like the draft-editing tools in hosting.mjs.
import { productI18n } from './i18n.mjs';

// The base confirmation sentence promises container/history/data loss; for a
// draft-only app that is false, so the card says what really goes away.
export async function draftOnlyNotice({ userId, system, getAppDraft, language }) {
  const draft = await getAppDraft(userId, system);
  if (!Object.keys(draft).length) return null;
  return { aviso: productI18n().t('confirm.apagar_sistema.draft_only_notice', language) };
}

export async function deleteDraftOnly({ userId, system, getAppDraft, clearAppDraft }) {
  const draft = await getAppDraft(userId, system);
  if (!Object.keys(draft).length) return { ok: false, error: `Não achei o sistema "${system}".` };
  await clearAppDraft(userId, system);
  return { ok: true, apagado: system, rascunho: true,
    obs: 'This system was never published; it was only a draft, with no container or app data. The draft was discarded; the same name can be used again.' };
}
