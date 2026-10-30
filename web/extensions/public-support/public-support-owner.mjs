// Owner's view of public support (public-support.mjs): configuring an assistant's
// public mode, viewing contacts and conversations (read-only), blocking,
// exporting and deleting a contact. The screen is web/public/public-support.html (/public-support).
//
// Every route requires a session. Who reaches an assistant is decided once, by access():
// its owner, or a member of the client area it is in (client-areas.mjs), with that member's
// role. The store is then called with the owner's id, so the owner check in its SQL
// (agents.user_id) stays as a second lock. A contact or assistant nobody let you into
// responds with 404, same as an id that doesn't exist; one you see but your role can't
// change responds with 403. The ones that change state are POST and go through the server's global CSRF.
import { readBody } from '../../http-body.mjs';
import { webFieldsFromBody } from './public-web.mjs';
import { AGENT_HOURLY_LIMIT_MAX } from './public-support.mjs';
import { AGENT_PROMPT_KINDS, PROMPT_MAX, asEdit, textState } from './public-support-prompts.mjs';
import { LINK_SITES_MAX, normalizeSite } from '../../links.mjs';
import { METRICS_PATH, METRIC_DAYS } from './public-support-metrics.mjs';
import { ACTIVITY_PATH } from './client-area-activity.mjs';
import { EVENTS_PATH, eventsCsv } from './public-support-events.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (UUID.test(String(v || '')) ? String(v) : null);
const inteiro = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const TETO_MAX_USD = 100000;
export const AGENT_TEXTS_PATH = '/api/public-support/texts';
// What a client area's admin may send to /api/publico/configurar; anything else is the owner's.
const CLIENT_ADMIN_FIELDS = new Set(['agentId', 'instrucoes', 'linkSites']);
const canEdit = (role) => role === 'owner' || role === 'admin';

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
// avatar (public-avatar.mjs) = the face on the web channel, when the server has avatars.
// areas (client-areas.mjs) = who else reaches an assistant; null = only its owner.
// metrics (public-support-metrics.mjs) = the assistant's volume, for every role, with
// metricCards({agentId, days, from, to}) → [{label, value}] = the plugin's cards (public-support.mjs).
// activity (client-area-activity.mjs) = the access log; each route below records its action there.
// events (public-support-events.mjs) = what the plugin recorded and the link clicks, as a spreadsheet.
export function registrarRotasDoDono({ rotas, store, webStore, send, fail, tooManyRequests, agenteDoNumero, available = async () => true,
  prompts = null, defaultTexts = async () => ({ written: '', spoken: null }), avatar = null, areas = null, metrics = null, metricCards = async () => [], activity = null, events = null }) {
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
  const forbidden = (res) => send(res, 403, { error: 'forbidden' });
  // → { ownerId, role } of the assistant or contact in the request, or null (= 404).
  const agentAccess = async (user, id) => {
    const agentId = uuid(id);
    if (!agentId) return null;
    return areas ? areas.agentAccess(user.id, agentId) : { ownerId: user.id, role: 'owner', agentId };
  };
  const contatoDoPedido = async (user, id) => {
    const c = uuid(id);
    const acc = c && (areas ? await areas.contactAccess(user.id, c) : { ownerId: user.id, role: 'owner' });
    return acc && (await store.contatoDoDono(acc.ownerId, c)) ? { ...acc, contatoId: c } : null;
  };
  // acc = what agentAccess or contatoDoPedido resolved.
  const record = (user, acc, action, detail = null) => activity?.record({ ownerId: acc.ownerId, actorId: user.id,
    agentId: acc.agentId ?? null, areaId: acc.areaId ?? null, action, detail });

  rota('GET', '/api/publico/agentes', async ({ res, user }) => {
    const doNumero = agenteDoNumero();
    const areaOf = areas ? await areas.areaOfAgents(user.id) : new Map();
    const agentes = (await store.agentesDoDono(user.id)).map((a) => ({
      agentId: a.agent_id, nome: a.nome, configurado: a.configurado, ativo: a.ativo, instrucoes: a.instrucoes,
      retencaoDias: a.retencao_dias, limitePorHora: a.limite_por_hora, tetoDiarioUsd: a.teto_diario_usd, agentHourlyLimit: a.agent_hourly_limit,
      linkSites: a.link_sites, contatos: a.contatos, doNumero: a.agent_id === doNumero,
      webEnabled: a.web_enabled, webOrigins: a.web_origins, webHasKey: a.web_has_key, webKeyIps: a.web_key_ips,
      ...(avatar ? avatar.view(a) : {}),
      role: 'owner', ...(areaOf.get(a.agent_id) || { areaId: null, areaName: null }),
    }));
    // The face is set in the assistant's settings; this screen only says whether it is ready.
    const avatarAvailable = !!avatar?.available();
    if (avatarAvailable) for (const a of agentes) a.avatarFace = await avatar.face(a.agentId, user.id);
    // A member sees what their role uses: no spend, limits or website channel settings.
    const asMember = areas ? await areas.memberAgents(user.id) : [];
    for (const ownerId of new Set(asMember.map((m) => m.ownerId))) {
      const ofOwner = new Map(asMember.filter((m) => m.ownerId === ownerId).map((m) => [m.agentId, m]));
      for (const a of await store.agentesDoDono(ownerId)) {
        const m = ofOwner.get(a.agent_id);
        if (m) agentes.push({ agentId: a.agent_id, nome: a.nome, configurado: a.configurado, ativo: a.ativo, instrucoes: a.instrucoes,
          linkSites: a.link_sites, contatos: a.contatos, doNumero: a.agent_id === doNumero, role: m.role, areaId: m.areaId, areaName: m.areaName });
      }
    }
    // panelAccount: the person has only this screen (client-areas.mjs), so it offers no way back to the app.
    return send(res, 200, { agentes, signupOpen: !(await available()), avatarAvailable, panelAccount: !!(await areas?.isPanelAccount(user.id)) });
  });

  rota('POST', '/api/publico/configurar', async ({ req, res, user }) => {
    const b = await readBody(req);
    const acc = await agentAccess(user, b.agentId);
    if (!acc) return naoAchei(res);
    const agentId = acc.agentId;
    if (acc.role !== 'owner' && (acc.role !== 'admin' || Object.keys(b).some((k) => !CLIENT_ADMIN_FIELDS.has(k)))) return forbidden(res);
    const { campos, erro } = camposDaConfig(b);
    if (acc.role !== 'owner') {
      if (erro) return send(res, 400, { error: erro });
      const r = await store.configurar(agentId, acc.ownerId, campos);
      if (!r) return naoAchei(res);
      await record(user, acc, 'settings_changed');
      return send(res, 200, { ok: true, agentId: r.agent_id, instrucoes: r.instrucoes, linkSites: r.link_sites });
    }
    const web = webFieldsFromBody(b);
    const face = avatar ? avatar.fields(b) : { campos: {} };
    if (erro || web.erro || face.erro) return send(res, 400, { error: erro || web.erro || face.erro });
    const r = await store.configurar(agentId, user.id, campos);
    if (!r) return naoAchei(res);
    const w = await webStore.configure(agentId, user.id, web.campos);
    if (!w) return naoAchei(res);
    const v = avatar && (await avatar.configure(agentId, user.id, face.campos));
    if (avatar && !v) return naoAchei(res);
    // Sessions the new settings no longer allow end now.
    if (avatar) avatar.agentChanged(agentId).catch((e) => console.error('[publico] avatar:', e?.message ?? e));
    await record(user, acc, 'settings_changed');
    return send(res, 200, { ...(v ? avatar.view(v) : {}), ok: true, agentId: r.agent_id, ativo: r.ativo, instrucoes: r.instrucoes, retencaoDias: r.retencao_dias,
      limitePorHora: r.limite_por_hora, tetoDiarioUsd: r.teto_diario_usd, agentHourlyLimit: r.agent_hourly_limit, linkSites: r.link_sites,
      webEnabled: w.web_enabled, webOrigins: w.web_origins, webHasKey: w.web_has_key, webKeyIps: w.web_key_ips });
  });

  // New server key for the website and API channel. It is shown only in this reply.
  rota('POST', '/api/publico/web-key', async ({ req, res, user }) => {
    const acc = await agentAccess(user, (await readBody(req)).agentId);
    if (!acc) return naoAchei(res);
    if (acc.role !== 'owner') return forbidden(res);
    const key = await webStore.newKey(acc.agentId, user.id);
    if (!key) return naoAchei(res);
    await record(user, acc, 'web_key_created');
    return send(res, 200, { ok: true, key });
  });

  rota('GET', '/api/publico/contatos', async ({ res, url, user }) => {
    const acc = await agentAccess(user, url.searchParams.get('agente'));
    if (!acc) return naoAchei(res);
    const antes = url.searchParams.get('antes');
    const quando = antes && !Number.isNaN(Date.parse(antes)) ? new Date(antes).toISOString() : null;
    return send(res, 200, { contatos: await store.contatosDoDono(acc.ownerId, acc.agentId, { antes: quando }) });
  });

  rota('GET', '/api/publico/conversa', async ({ res, url, user }) => {
    const c = await contatoDoPedido(user, url.searchParams.get('contato'));
    if (!c) return naoAchei(res);
    const antes = Number(url.searchParams.get('antes'));
    // Opening it is the first page; paging back through it is the same opening.
    if (!url.searchParams.has('antes')) await record(user, c, 'conversation_opened');
    return send(res, 200, { mensagens: await store.conversaDoDono(c.ownerId, c.contatoId, { antes: Number.isSafeInteger(antes) && antes > 0 ? antes : null }) });
  });

  rota('POST', '/api/publico/bloquear', async ({ req, res, user }) => {
    const b = await readBody(req);
    const c = await contatoDoPedido(user, b.contatoId);
    if (!c) return naoAchei(res);
    if (!canEdit(c.role)) return forbidden(res);
    const { contatoId } = c;
    if (typeof b.bloqueado !== 'boolean') return send(res, 400, { error: 'bloqueado precisa ser verdadeiro ou falso.' });
    await store.bloquear(contatoId, b.bloqueado);
    if (b.bloqueado) avatar?.contactClosed(contatoId);
    await record(user, c, b.bloqueado ? 'contact_blocked' : 'contact_unblocked');
    return send(res, 200, { ok: true, bloqueado: b.bloqueado });
  });

  rota('POST', '/api/publico/apagar', async ({ req, res, user }) => {
    const c = await contatoDoPedido(user, (await readBody(req)).contatoId);
    if (!c) return naoAchei(res);
    if (!canEdit(c.role)) return forbidden(res);
    const { contatoId } = c;
    await store.apagarContato(contatoId);
    avatar?.contactClosed(contatoId);
    await record(user, c, 'contact_deleted');
    return send(res, 200, { ok: true });
  });

  // Data subject access request (LGPD): the owner downloads everything that exists about the contact.
  rota('GET', '/api/publico/exportar', async ({ res, url, user }) => {
    const c = await contatoDoPedido(user, url.searchParams.get('contato'));
    if (!c) return naoAchei(res);
    if (!canEdit(c.role)) return forbidden(res);
    const { contatoId } = c;
    const dados = await store.exportar(contatoId);
    if (!dados) return naoAchei(res);
    await record(user, c, 'contact_exported');
    return send(res, 200, dados, { 'content-disposition': `attachment; filename="contato-${contatoId}.json"` });
  });

  if (metrics) rota('GET', METRICS_PATH, async ({ res, url, user }) => {
    const acc = await agentAccess(user, url.searchParams.get('agent'));
    if (!acc) return naoAchei(res);
    const days = Number(url.searchParams.get('days'));
    if (!METRIC_DAYS.includes(days)) return send(res, 400, { error: 'bad_days', allowed: METRIC_DAYS });
    const volume = await metrics.volume(acc.ownerId, acc.agentId, days);
    const cards = volume.daily.length ? await metricCards({ agentId: acc.agentId, days, from: volume.daily[0].day, to: volume.daily.at(-1).day }) : [];
    return send(res, 200, { ...volume, cards });
  });

  // The period's events as a spreadsheet, for everyone who sees the metrics.
  if (events && metrics) rota('GET', EVENTS_PATH, async ({ res, url, user }) => {
    const acc = await agentAccess(user, url.searchParams.get('agent'));
    if (!acc) return naoAchei(res);
    const days = Number(url.searchParams.get('days'));
    if (!METRIC_DAYS.includes(days)) return send(res, 400, { error: 'bad_days', allowed: METRIC_DAYS });
    const rows = await events.list(acc.ownerId, acc.agentId, days);
    if (!rows) return naoAchei(res);
    await record(user, acc, 'events_exported', { days, rows: rows.length });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="events-${acc.agentId}-${days}d.csv"` });
    return res.end('\ufeff' + eventsCsv(rows));
  });

  // The access log: the owner reads all of it, an area's admin the area's part; a viewer none.
  if (activity) rota('GET', ACTIVITY_PATH, async ({ res, url, user }) => {
    const acc = await agentAccess(user, url.searchParams.get('agent'));
    if (!acc) return naoAchei(res);
    if (!canEdit(acc.role)) return forbidden(res);
    if (acc.role !== 'owner' && !acc.areaId) return naoAchei(res);
    const before = Number(url.searchParams.get('before'));
    return send(res, 200, { lines: await activity.list({ ownerId: acc.ownerId, areaId: acc.role === 'owner' ? null : acc.areaId,
      before: Number.isSafeInteger(before) && before > 0 ? before : null }) });
  });

  if (prompts) registerAgentTexts();

  // The assistant's written and spoken texts: the plugin's default prefilled, the
  // owner's edits with their versions. Spoken exists only when the plugin has a
  // default for it (the assistant answers voice). Written stays off the screen
  // (null) while there is neither a default nor an edit: the extra instructions
  // already cover an assistant without a plugin text.
  function registerAgentTexts() {
    const notFound = (res) => send(res, 404, { error: 'not_found' });
    const key = (agentId, kind, acc) => ({ agentId, kind, userId: acc.ownerId });
    const fallbackOf = (d, kind) => (kind === 'spoken' ? d.spoken : d.written);

    rota('GET', AGENT_TEXTS_PATH, async ({ res, url, user }) => {
      const acc = await agentAccess(user, url.searchParams.get('agent'));
      if (!acc) return notFound(res);
      const { agentId } = acc;
      const d = await defaultTexts(agentId);
      const written = await textState(prompts, key(agentId, 'written', acc), d.written);
      if (!written) return notFound(res);
      const spoken = d.spoken == null ? null : await textState(prompts, key(agentId, 'spoken', acc), d.spoken);
      return send(res, 200, { written: d.written || written.content ? written : null, spoken });
    });

    // Body { agentId, kind, content? | versionId? }. Resolves who may edit and the
    // text's default: null = 404 (no access, or that text can't be edited here),
    // { forbidden } = a role that only reads.
    const editable = async (b, user) => {
      const acc = await agentAccess(user, b?.agentId);
      if (!acc || !AGENT_PROMPT_KINDS.includes(b.kind)) return null;
      if (!canEdit(acc.role)) return { forbidden: true };
      const fallback = fallbackOf(await defaultTexts(acc.agentId), b.kind);
      return fallback == null ? null : { agentId: acc.agentId, kind: b.kind, fallback, acc };
    };

    // { content }: '' or the default itself = back to the default.
    rota('POST', AGENT_TEXTS_PATH, async ({ req, res, user }) => {
      const b = await readBody(req);
      const text = await editable(b, user);
      if (!text) return notFound(res);
      if (text.forbidden) return forbidden(res);
      if (typeof b.content !== 'string') return send(res, 400, { error: 'bad_request' });
      if (b.content.trim().length > PROMPT_MAX) return send(res, 400, { error: 'too_long', max: PROMPT_MAX });
      const k = key(text.agentId, text.kind, text.acc);
      if (!(await prompts.save({ ...k, content: asEdit(b.content, text.fallback) }))) return notFound(res);
      await record(user, text.acc, 'text_changed', { kind: text.kind });
      return send(res, 200, await textState(prompts, k, text.fallback));
    });

    rota('POST', AGENT_TEXTS_PATH + '/restore', async ({ req, res, user }) => {
      const b = await readBody(req);
      const text = await editable(b, user);
      if (text?.forbidden) return forbidden(res);
      const k = text && key(text.agentId, text.kind, text.acc);
      if (!k || !(await prompts.restore({ ...k, versionId: b.versionId }))) return notFound(res);
      await record(user, text.acc, 'text_restored', { kind: text.kind });
      return send(res, 200, await textState(prompts, k, text.fallback));
    });
  }
}
