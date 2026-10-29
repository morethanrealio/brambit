// Public support: assistants that answer people without an account, on the
// installation's WhatsApp number and on a website (public-support-channel.mjs
// has the whole picture). The owner runs them at /public-support.
//
// An extension (extensions.mjs): a plugin object that ships with Brambit. It
// answers the core's contacts without an account (guest-contacts.mjs) and opens
// the atendimentoPublico port (public-support.mjs) to the installation's plugins.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarAtendimentoDoServidor, esquemaDoAtendimento, PUBLIC_WEB_PATHS } from './public-support-channel.mjs';

export default {
  nome: 'public-support',
  esquema: esquemaDoAtendimento,
  // Public web channel: no cookie; the origin is checked per agent (public-web.mjs).
  semCsrf: [...PUBLIC_WEB_PATHS],
  // The owner's screen and the script a website embeds.
  publico: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')],
  ligar(servidor) {
    const { pool, avatar, recordUsages, getCreditStatus, ferramentas, rotas, send, fail, tooManyRequests, clientIp, ports, signupOpen, chatProvider, guestContacts } = servidor;
    const atendimento = criarAtendimentoDoServidor({ pool, avatar, recordUsages, creditStatus: getCreditStatus, ferramentas, rotas, send, fail, tooManyRequests, clientIp,
      ganchos: ports.atendimentoPublico, signupOpen, makeProvider: ({ userId, agentId }) => chatProvider({ userId, agentId, kind: 'publico' }) });
    guestContacts.register({ whatsapp: atendimento.whatsapp }, 'public-support');
  },
};
