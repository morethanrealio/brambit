// Connects public support (public-support.mjs) to the server and to WhatsApp.
//
// Phase 1 uses the installation's single number. Whoever installs it chooses WHICH assistant
// handles those without an account (PUBLIC_SUPPORT_AGENT = agent id); the owner
// of that assistant turns it on and off in public_agents.ativo. Without the variable, or with
// support turned off, nothing changes: an unlinked number keeps receiving the
// login message. The choice belongs to the installation, not to each user, because the
// number is a single one: if any owner could turn it on, every stranger would go to
// their assistant.
import { defaultTimezone } from '../../locale.mjs';
import { randomUUID } from 'node:crypto';
import { createPublicoStore, createAtendimentoPublico, esquemaPublico } from './public-support.mjs';
import { registrarRotasDoDono } from './public-support-owner.mjs';
import { promptSchema, createPromptStore } from './public-support-prompts.mjs';
import { registerPublicSupportAdmin } from './public-support-admin.mjs';
import { createPublicWebStore, registerPublicWebRoutes, PUBLIC_WEB_PATHS as WEB_PATHS } from './public-web.mjs';
import { createPublicAvatarStore, registerPublicAvatar, PUBLIC_AVATAR_PATHS } from './public-avatar.mjs';
import { publicSupportOn } from '../../profiles.mjs';
import { createMetricsStore } from './public-support-metrics.mjs';
import { clientAreaSchema, createClientAreaStore, registerClientAreaRoutes, panelScope } from './client-areas.mjs';
import { activitySchema, createActivityStore } from './client-area-activity.mjs';
import { createEventsStore, measureLinks, registerClickRoute } from './public-support-events.mjs';

export const PUBLIC_WEB_PATHS = new Set([...WEB_PATHS, ...PUBLIC_AVATAR_PATHS]);

const LIMPEZA_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Joins the initDb schema list.
export const esquemaDoAtendimento = async ({ pool, S }) => { await pool.query(esquemaPublico(S)); await pool.query(promptSchema(S)); await pool.query(clientAreaSchema(S)); await pool.query(activitySchema(S)); };

export const agentePublicoDoNumero = (valor = process.env.PUBLIC_SUPPORT_AGENT) => {
  const id = String(valor || '').trim();
  return UUID.test(id) ? id : null;
};

const agoraPorExtenso = () => new Date().toLocaleString('pt-BR', {
  timeZone: defaultTimezone(), weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// deps: database pool/S; makeProvider(ident) already tied to the owner's spend;
// recordUsages and creditStatus from the server; ferramentas = tools port;
// ganchos = plugin's atendimentoPublico port (script; see public-support.mjs).
// Returns what the WhatsApp channel uses: atende() says whether support is on
// for the number; turno({endereco,mensagem,imagens?}) → {text,saidas?,motivo?,userId,agentId}.
// A number has no key, so its photos reach the model only as the answer to the
// assistant's request (imagesOnRequest; else motivo 'photo_not_requested').
// Retention (deleting what's past retencao_dias) runs on its own every
// limpezaMs, the first one a minute after boot; limpezaMs=0 turns it off.
// With routes (+ send/fail/tooManyRequests/clientIp from the server), registers the owner's view
// (public-support-owner.mjs), the public web channel (public-web.mjs), the
// admin's installation text (public-support-admin.mjs) and the owner's client areas
// (client-areas.mjs), which also open the owner's view to an area's members. avatar = what
// registerAvatar returns, for the face on the web channel (public-avatar.mjs).
// accountScope (account-scope.mjs) holds the panel accounts a client area
// invites to this screen; publicBase() → the address their password link uses.
// signupOpen() → true when anyone can create an account here (the core's
// BRAMBIT_SIGNUP). Public support then stays off on every channel: the address
// it hands to the public would also hand out accounts paid by the owner. null =
// a plugin decides sign-up, and with it whether that is safe.
// enabled=false (the personal usage profile, profiles.mjs) keeps it off too.
// clientAreas=false (the default, without BRAMBIT_CLIENT_AREAS=on): no areas, so
// the screen is the owner's alone; a panel account an area invited stays held to
// it (account-scope.mjs) but reaches no assistant.
export const clientAreasOn = (value = process.env.BRAMBIT_CLIENT_AREAS) => String(value ?? '').trim().toLowerCase() === 'on';
export function criarAtendimentoDoServidor({ pool, S, makeProvider, recordUsages, creditStatus, ferramentas, ganchos = null, agenteDoNumero = () => agentePublicoDoNumero(), log = console, limpezaMs = LIMPEZA_MS,
  rotas, send, fail, tooManyRequests, clientIp, signupOpen = null, enabled = publicSupportOn, avatar = null, accountScope = null, publicBase = () => '', clientAreas = clientAreasOn() }) {
  const store = createPublicoStore(pool, { S });
  const events = createEventsStore(pool, { S, log });
  const webStore = createPublicWebStore(pool, { S, measure: (outputs, ident) => measureLinks(events, publicBase(), ident, outputs) });
  const prompts = createPromptStore(pool, { S });
  const areas = createClientAreaStore(pool, { S });
  const activity = createActivityStore(pool, { S, log });
  // A failed check counts as open. Logged once each time it turns support off.
  let warned = false;
  const available = async () => {
    if (!enabled) return false;
    let open = false;
    if (signupOpen) { try { open = !!(await signupOpen()); } catch (e) { open = true; log.error?.('[publico] sign-up check failed:', e?.message ?? e); } }
    if (open && !warned) log.warn?.('[publico] sign-up is open (BRAMBIT_SIGNUP); public support stays off until it is closed');
    warned = open;
    return !open;
  };
  const limpar = async () => {
    try {
      const r = await store.limparVencidos();
      if (r.mensagens || r.anotacoes || r.contatos) log.log?.(`[publico] retenção: ${r.contatos} contato(s), ${r.mensagens} mensagem(ns), ${r.anotacoes} anotação(ões) apagadas`);
      if (r.events || r.links) log.log?.(`[publico] retention: ${r.events} event(s), ${r.links} link(s) deleted`);
    } catch (e) { log.error?.('[publico] retenção falhou:', e?.message ?? e); }
  };
  if (limpezaMs > 0) {
    setTimeout(limpar, Math.min(60_000, limpezaMs)).unref?.();
    setInterval(limpar, limpezaMs).unref?.();
  }
  const atendimento = createAtendimentoPublico({
    store, makeProvider, ferramentas, ganchos, prompts, events, linkBase: publicBase, log, agora: agoraPorExtenso,
    saldo: creditStatus,
    recordUsage: (usages, { userId, agentId }) => recordUsages(usages, { userId, agentId, threadId: null, turnId: randomUUID(), kind: 'publico' }),
  });
  if (rotas) {
    const face = avatar && registerPublicAvatar({ rotas, avatar, store, webStore, avatarStore: createPublicAvatarStore(pool, { S }), creditStatus,
      send, fail, tooManyRequests, clientIp, available });
    registrarRotasDoDono({ rotas, store, webStore, send, fail, tooManyRequests, agenteDoNumero, available, prompts, defaultTexts: atendimento.defaultTexts, avatar: face || null, areas: clientAreas ? areas : null,
      metrics: createMetricsStore(pool, { S }), metricCards: atendimento.metricCards, activity, events });
    if (clientAreas) registerClientAreaRoutes({ rotas, areas, send, fail, tooManyRequests, publicBase, log, activity });
    accountScope?.register(panelScope(areas));
    registerClickRoute({ rotas, events, send, log });
    registerPublicWebRoutes({ rotas, webStore, turno: atendimento.turno, send, fail, tooManyRequests, clientIp, available, afterTurn: face ? face.afterTurn : null });
    if (enabled) registerPublicSupportAdmin({ rotas, prompts });
  }
  return {
    store, webStore, prompts, areas, events, limpar,
    whatsapp: {
      async atende() { const id = agenteDoNumero(); return !!id && (await available()) && !!(await store.agente(id))?.ativo; },
      turno: ({ endereco, mensagem, imagens }) => atendimento.turno({ agentId: agenteDoNumero(), canal: 'whatsapp', endereco, mensagem,
        ...(imagens?.length ? { imagens, imagesOnRequest: true } : {}) }),
    },
  };
}
