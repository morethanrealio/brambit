// First chat when the instance has no Google or Microsoft sign-in to connect:
// the wizard goes from naming the assistant straight to a conversation that the
// assistant opens itself (who it is, what it helps with, three questions to get
// to know the person). POST /api/onboard/intro {agentId} answers {threadId}.
// The opening goes into the thread history too, so the model knows it asked.
import { readBody } from './http-body.mjs';
import { appendAssistantToThread, getAgentOwned, getOrCreateThreadByTitle, getUserLocale } from './db.mjs';
import { productI18n } from './i18n.mjs';
import { sttEnabled } from './media.mjs';

export function introText({ name, voice, language, i18n = productI18n() }) {
  return {
    title: i18n.t('onboarding.intro.title', language),
    text: i18n.t('onboarding.intro.message', language, {
      name,
      voice_hint: voice ? i18n.t('onboarding.intro.voice_hint', language) : '',
    }),
  };
}

export function registerOnboardingIntro(rotas) {
  rotas.registrar('POST', '/api/onboard/intro', async (req, res, url, ctx) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const user = await ctx.currentUser?.();
      if (!user) return reply(401, { error: 'unauthorized' });
      const { agentId } = await readBody(req);
      const agent = typeof agentId === 'string' && await getAgentOwned(agentId, user.id);
      if (!agent) return reply(404, { error: 'agent_not_found' });
      const { language } = await getUserLocale(user.id);
      const { title, text } = introText({ name: agent.name, voice: sttEnabled(), language });
      const thread = await getOrCreateThreadByTitle({ agentId: agent.id, userId: user.id, title });
      // The delivery key makes a repeated request (double click, reload) a no-op.
      await appendAssistantToThread({ threadId: thread.id, userId: user.id, text, deliveryKey: `onboarding-intro:${agent.id}` });
      return reply(200, { threadId: thread.id });
    } catch (e) {
      console.error('[onboarding-intro]', e?.message ?? e);
      return reply(500, { error: 'onboarding_intro_failed' });
    }
  });
}
