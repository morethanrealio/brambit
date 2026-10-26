// Owner's view of public support (public-support.mjs): configuring an assistant's
// public mode, viewing contacts and conversations (read-only), blocking,
// exporting and deleting a contact. The screen is web/public/public-support.html (/public-support).
//
// Every route requires a session. The owner is checked in the store's SQL (agents.user_id), and
// a contact or assistant from another account responds with 404, same as an id that doesn't exist.
// The ones that change state are POST and go through the server's global CSRF.
import { readBody } from './http-body.mjs';
import { webFieldsFromBody } from './public-web.mjs';
import { AGENT_HOURLY_LIMIT_MAX } from './public-support.mjs';
import { AGENT_PROMPT_KINDS, PROMPT_MAX, asEdit, textState } from './public-support-prompts.mjs';
import { LINK_SITES_MAX, normalizeSite } from './links.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (UUID.test(String(v || '')) ? String(v) : null);
const inteiro = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const TETO_MAX_USD = 100000;
export const AGENT_TEXTS_PATH = '/api/public-support/texts';

// What comes from the form becomes store.configurar fields; a missing field stays
// as is. Returns {erro} if any value is invalid.
export function camposDaConfig(b = {}) {
  const c = {};
  if (b.ativo !== undefined) { if (typeof b.ativo !== 'boolean') return { erro: 'ativo precisa ser verdadeiro ou falso.' }; c.ativo = b.ativo; }
  if (b.instrucoes !== undefined) { if (typeof b.instrucoes !== 'string') return { erro: 'Instruções inválidas.' }; c.instrucoes = b.instrucoes; }
  if (b.retencaoDias !== undefined) {
    c.retencaoDias = inteiro(b.retencaoDias, 1, 3650);
    if (c.retencaoDias === undefined) return { erro: 'A retenção vai de 1 a 3650 dias.' };
  }
  if (b.limitePorHora !== undefined) {
    c.limitePorHora = inteiro(b.limitePorHora, 1, 600);
    if (c.limitePorHora === undefined) return { erro: 'O limite por hora vai de 1 a 600 mensagens.' };
  }
  if (b.tetoDiarioUsd !== undefined) {
    const t = b.tetoDiarioUsd;
    if (t !== null && !(typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= TETO_MAX_USD)) return { erro: 'server.public_daily_cap_invalid' };
    c.tetoDiarioUsd = t;
  }
  if (b.agentHourlyLimit !== undefined) {
    c.agentHourlyLimit = inteiro(b.agentHourlyLimit, 1, AGENT_HOURLY_LIMIT_MAX);
    if (c.agentHourlyLimit === undefined) return { erro: 'server.public_agent_hourly_limit_invalid' };
  }
  if (b.linkSites !== undefined) {
    if (!Array.isArray(b.linkSites) || b.linkSites.length > LINK_SITES_MAX) return { erro: 'server.public_link_sites_too_many' };
    const sites = b.linkSites.map(normalizeSite);
    if (sites.some((s) => !s)) return { erro: 'server.public_link_site_invalid' };
    c.linkSites = [...new Set(sites)];
  }
  return { campos: c };
}

// deps: routes (routes.mjs), store (createPublicoStore), send/fail/tooManyRequests
// from the server, agenteDoNumero() = id of the assistant that serves the installation's number,
// webStore (public-web.mjs) = the website and API channel's settings, available() → false
// while the installation keeps public support off (the screen then says why).
// prompts (public-support-prompts.mjs) + defaultTexts(agentId) → {written, spoken}
// (the plugin's texts, public-support.mjs) = the assistant's editable texts.
export function registrarRotasDoDono({ rotas, store, webStore, send, fail, tooManyRequests, agenteDoNumero, available = async () => true,
  prompts = null, defaultTexts = async () => ({ written: '', spoken: null }) }) {
  // Wraps each route: session, no cache, request limit and no-detail error.
  const rota = (metodo, caminho, tratar) => rotas.registrar(metodo, caminho, async (req, res, url, ctx) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = await ctx.currentUser?.();
    if (!user) return send(res, 401, { error: 'Faça login pra ver o atendimento ao público.' });
    if (tooManyRequests(req, res, 'publico-dono', 120, 60_000)) return;
    try { return await tratar({ req, res, url, user }); }
    catch (e) { return fail(res, 500, 'Falha no atendimento ao público.', e); }
  });
  const naoAchei = (res) => send(res, 404, { error: 'Não encontrado.' });
  // Contact from the request, only if it belongs to the owner.
  const contatoDoPedido = async (user, id) => { const c = uuid(id); return c && (await store.contatoDoDono(user.id, c)) ? c : null; };

  rota('GET', '/api/publico/agentes', async ({ res, user }) => {
    const doNumero = agenteDoNumero();
    const agentes = (await store.agentesDoDono(user.id)).map((a) => ({
      agentId: a.agent_id, nome: a.nome, configurado: a.configurado, ativo: a.ativo, instrucoes: a.instrucoes,
      retencaoDias: a.retencao_dias, limitePorHora: a.limite_por_hora, tetoDiarioUsd: a.teto_diario_usd, agentHourlyLimit: a.agent_hourly_limit,
      linkSites: a.link_sites, contatos: a.contatos, doNumero: a.agent_id === doNumero,
      webEnabled: a.web_enabled, webOrigins: a.web_origins, webHasKey: a.web_has_key, webKeyIps: a.web_key_ips,
    }));
    return send(res, 200, { agentes, signupOpen: !(await available()) });
  });

  rota('POST', '/api/publico/configurar', async ({ req, res, user }) => {
    const b = await readBody(req);
    const agentId = uuid(b.agentId);
    if (!agentId) return naoAchei(res);
    const { campos, erro } = camposDaConfig(b);
    const web = webFieldsFromBody(b);
    if (erro || web.erro) return send(res, 400, { error: erro || web.erro });
    const r = await store.configurar(agentId, user.id, campos);
    if (!r) return naoAchei(res);
    const w = await webStore.configure(agentId, user.id, web.campos);
    if (!w) return naoAchei(res);
    return send(res, 200, { ok: true, agentId: r.agent_id, ativo: r.ativo, instrucoes: r.instrucoes, retencaoDias: r.retencao_dias,
      limitePorHora: r.limite_por_hora, tetoDiarioUsd: r.teto_diario_usd, agentHourlyLimit: r.agent_hourly_limit, linkSites: r.link_sites,
      webEnabled: w.web_enabled, webOrigins: w.web_origins, webHasKey: w.web_has_key, webKeyIps: w.web_key_ips });
  });

  // New server key for the website and API channel. It is shown only in this reply.
  rota('POST', '/api/publico/web-key', async ({ req, res, user }) => {
    const agentId = uuid((await readBody(req)).agentId);
    const key = agentId && (await webStore.newKey(agentId, user.id));
    if (!key) return naoAchei(res);
    return send(res, 200, { ok: true, key });
  });

  rota('GET', '/api/publico/contatos', async ({ res, url, user }) => {
    const agentId = uuid(url.searchParams.get('agente'));
    if (!agentId) return naoAchei(res);
    const antes = url.searchParams.get('antes');
    const quando = antes && !Number.isNaN(Date.parse(antes)) ? new Date(antes).toISOString() : null;
    return send(res, 200, { contatos: await store.contatosDoDono(user.id, agentId, { antes: quando }) });
  });

  rota('GET', '/api/publico/conversa', async ({ res, url, user }) => {
    const contatoId = await contatoDoPedido(user, url.searchParams.get('contato'));
    if (!contatoId) return naoAchei(res);
    const antes = Number(url.searchParams.get('antes'));
    return send(res, 200, { mensagens: await store.conversaDoDono(user.id, contatoId, { antes: Number.isSafeInteger(antes) && antes > 0 ? antes : null }) });
  });

  rota('POST', '/api/publico/bloquear', async ({ req, res, user }) => {
    const b = await readBody(req);
    const contatoId = await contatoDoPedido(user, b.contatoId);
    if (!contatoId) return naoAchei(res);
    if (typeof b.bloqueado !== 'boolean') return send(res, 400, { error: 'bloqueado precisa ser verdadeiro ou falso.' });
    await store.bloquear(contatoId, b.bloqueado);
    return send(res, 200, { ok: true, bloqueado: b.bloqueado });
  });

  rota('POST', '/api/publico/apagar', async ({ req, res, user }) => {
    const contatoId = await contatoDoPedido(user, (await readBody(req)).contatoId);
    if (!contatoId) return naoAchei(res);
    await store.apagarContato(contatoId);
    return send(res, 200, { ok: true });
  });

  // Data subject access request (LGPD): the owner downloads everything that exists about the contact.
  rota('GET', '/api/publico/exportar', async ({ res, url, user }) => {
    const contatoId = await contatoDoPedido(user, url.searchParams.get('contato'));
    if (!contatoId) return naoAchei(res);
    const dados = await store.exportar(contatoId);
    if (!dados) return naoAchei(res);
    return send(res, 200, dados, { 'content-disposition': `attachment; filename="contato-${contatoId}.json"` });
  });

  if (prompts) registerAgentTexts();

  // The assistant's written and spoken texts: the plugin's default prefilled, the
  // owner's edits with their versions. Spoken exists only when the plugin has a
  // default for it (the assistant answers voice). Written stays off the screen
  // (null) while there is neither a default nor an edit: the extra instructions
  // already cover an assistant without a plugin text.
  function registerAgentTexts() {
    const notFound = (res) => send(res, 404, { error: 'not_found' });
    const key = (agentId, kind, user) => ({ agentId, kind, userId: user.id });
    const fallbackOf = (d, kind) => (kind === 'spoken' ? d.spoken : d.written);

    rota('GET', AGENT_TEXTS_PATH, async ({ res, url, user }) => {
      const agentId = uuid(url.searchParams.get('agent'));
      if (!agentId) return notFound(res);
      const d = await defaultTexts(agentId);
      const written = await textState(prompts, key(agentId, 'written', user), d.written);
      if (!written) return notFound(res);
      const spoken = d.spoken == null ? null : await textState(prompts, key(agentId, 'spoken', user), d.spoken);
      return send(res, 200, { written: d.written || written.content ? written : null, spoken });
    });

    // Body { agentId, kind, content? | versionId? }. Resolves the text's default,
    // or null when that text can't be edited here.
    const editable = async (b) => {
      const agentId = uuid(b?.agentId);
      if (!agentId || !AGENT_PROMPT_KINDS.includes(b.kind)) return null;
      const fallback = fallbackOf(await defaultTexts(agentId), b.kind);
      return fallback == null ? null : { agentId, kind: b.kind, fallback };
    };

    // { content }: '' or the default itself = back to the default.
    rota('POST', AGENT_TEXTS_PATH, async ({ req, res, user }) => {
      const b = await readBody(req);
      const text = await editable(b);
      if (!text) return notFound(res);
      if (typeof b.content !== 'string') return send(res, 400, { error: 'bad_request' });
      if (b.content.trim().length > PROMPT_MAX) return send(res, 400, { error: 'too_long', max: PROMPT_MAX });
      const k = key(text.agentId, text.kind, user);
      if (!(await prompts.save({ ...k, content: asEdit(b.content, text.fallback) }))) return notFound(res);
      return send(res, 200, await textState(prompts, k, text.fallback));
    });

    rota('POST', AGENT_TEXTS_PATH + '/restore', async ({ req, res, user }) => {
      const b = await readBody(req);
      const text = await editable(b);
      const k = text && key(text.agentId, text.kind, user);
      if (!k || !(await prompts.restore({ ...k, versionId: b.versionId }))) return notFound(res);
      return send(res, 200, await textState(prompts, k, text.fallback));
    });
  }
}
