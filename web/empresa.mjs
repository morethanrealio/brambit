// Company account, phases F0 and F1.
//
// What lives here: the company (org), the list of allowed domains, members and
// invites. Since F1 the company also has its own plan and credit balance,
// shared by all members (the balance account is the same as the person's, in
// credit-status.mjs); the billing columns and tables live in a plugin
// (empresaCobrancaSchemaSql, org-billing.mjs). Anyone not in a company never
// goes through any of this.
//
// Locks (F1): joining, creating and leaving change WHICH account pays for the
// person's usage, so they take the same locks as the credit reserve, in the
// same order (person, then company; travas-de-conta.mjs) and BEFORE the
// company row lock. So no reserve is caught in the middle of an account swap.
//
// Rules:
// - A person is in at most ONE company (UNIQUE on org_members.user_id).
// - A domain is not unique system-wide: two companies may list the same domain
//   (there's no DNS proof). What's unique is (company, domain).
// - Joining is invite-only, and the invited e-mail must be on a listed domain.
// - The operator can block joining (impedeEntrada; e.g. a plan-based plugin can
//   require an active paid personal plan to be cancelled before accepting).
// - A member only connects Google/Microsoft on a listed domain; connectors
//   without e-mail (WhatsApp, Telegram, GitHub, Notion, Slack, API key, MCP) are free.
//
// No db connection/import here: db.mjs injects the pool and tests use PGlite
// with the same functions. Billing (paid plan, packs, refund) enters through
// the hooks below, wired by a plugin; in the open version none is wired and
// the company is just members, domains and invites.

import { lockCreditUser, lockCreditOrg } from './travas-de-conta.mjs';

// Public email providers: don't identify any company, so they don't go into
// the domain list and can't be used to create a company. Short list on
// purpose (the big ones from Brazil and abroad); `yahoo.*` covers the regional ones.
export const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com', 'live.com.br', 'msn.com',
  'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com', 'privaterelay.appleid.com',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com', 'globomail.com', 'r7.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com',
]);
const YAHOO = /^yahoo\.[a-z.]+$/;

const DOMINIO_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Domain in canonical form: lowercase, no spaces, no leading "@" and no
// trailing dot. Returns '' if it isn't a valid domain.
export function normalizeDomain(d) {
  const s = String(d || '').trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
  return DOMINIO_RE.test(s) ? s : '';
}
export function emailDomain(email) {
  const s = String(email || '').trim().toLowerCase();
  const i = s.lastIndexOf('@');
  return i > 0 ? normalizeDomain(s.slice(i + 1)) : '';
}
export const isPublicDomain = (d) => { const n = normalizeDomain(d); return !!n && (PUBLIC_MAIL_DOMAINS.has(n) || YAHOO.test(n)); };

// EXACT comparison: sub.empresa.com.br doesn't count as empresa.com.br.
// Whoever uses a subdomain registers the subdomain.
const noDominio = (email, dominios) => { const d = emailDomain(email); return !!d && dominios.includes(d); };

export function empresaSchemaSql(S = 'mtr_harness') {
  return `
  CREATE TABLE IF NOT EXISTS ${S}.orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    owner_user_id uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS ${S}.org_domains (
    org_id uuid NOT NULL REFERENCES ${S}.orgs(id) ON DELETE CASCADE,
    domain text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, domain));
  CREATE INDEX IF NOT EXISTS org_domains_domain_idx ON ${S}.org_domains (domain);
  CREATE TABLE IF NOT EXISTS ${S}.org_members (
    org_id uuid NOT NULL REFERENCES ${S}.orgs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL UNIQUE REFERENCES ${S}.users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('admin','membro')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id));
  CREATE TABLE IF NOT EXISTS ${S}.org_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES ${S}.orgs(id) ON DELETE CASCADE,
    email text NOT NULL,
    invited_by uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz);
  CREATE UNIQUE INDEX IF NOT EXISTS org_invites_pending_uq ON ${S}.org_invites (org_id, email) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS org_invites_email_pending_idx ON ${S}.org_invites (email) WHERE status = 'pending';
  `;
}

const erro = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

// deps: S (schema, default mtr_harness) and the hooks, which can also be
// wired later with store.ligar({...}):
//  - avisoAoConvidar(userId): text (or null) that goes in the invite's
//    `aviso` when the invited e-mail already has an account.
//  - impedeEntrada(userId): { error, code? } (or null) that blocks accepting
//    the invite with 409.
//  - aoEntrar(client, { userId, orgId, origem }): runs in the transaction of
//    whoever just became a member, with the credit guards already taken.
//    origem is 'criar' (whoever creates the company) or 'convite' (whoever
//    accepts an invite).
//  - aoCriar(client, { userId, orgId }): only on creation, after aoEntrar and
//    in the same transaction. Ends the creator's personal plan (org-billing.mjs:
//    person goes to Free, plan leftover becomes extra company credit,
//    subscription marked to cancel) and returns { sobra, sobraVenceEm,
//    cancelaAssinatura } when there was a plan, which the creator returns in
//    `planoPessoal`. An error with `empresaErro` undoes everything and becomes
//    the response.
//  - depoisDeEntrar({ userId, orgId, origem }): runs AFTER the join commits
//    (invite: Stripe refund of the invitee's paid package, org-join-refund.mjs;
//    create: cancellation of the creator's personal subscription,
//    org-billing.mjs). Its failure is only logged: the join already counted,
//    and whatever didn't go through stays pending for a retry.
//  - linhaDoConvite(): sentence (or null) about how the company account works
//    for whoever installs it, which goes in the invite e-mail
//    (empresa-convite-email.mjs).
export function createEmpresaStore(pool, { S = 'mtr_harness', ...ganchos } = {}) {
  const gancho = {
    avisoAoConvidar: async () => null, impedeEntrada: async () => null,
    aoEntrar: async () => {}, aoCriar: async () => null, depoisDeEntrar: async () => {}, linhaDoConvite: () => null,
  };
  const ligar = (novos = {}) => {
    for (const [k, fn] of Object.entries(novos)) {
      if (!(k in gancho)) throw Error('Gancho de empresa desconhecido: ' + k);
      if (typeof fn !== 'function') throw Error('Gancho de empresa sem função: ' + k);
      gancho[k] = fn;
    }
  };
  ligar(ganchos);
  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async function aposEntrada(out, ctx) {
    if (!out?.ok || out.aceito === false) return out;
    try { await gancho.depoisDeEntrar(ctx); }
    catch (e) { console.error(`[empresa] post-entry failed user=${ctx.userId} org=${ctx.orgId}: ${e?.message ?? e}`); }
    return out;
  }
  async function membership(userId, db = pool) {
    const { rows } = await db.query(
      `SELECT m.org_id, m.role, o.name FROM ${S}.org_members m JOIN ${S}.orgs o ON o.id = m.org_id WHERE m.user_id = $1`, [userId]);
    return rows[0] || null;
  }
  async function dominios(orgId, db = pool) {
    const { rows } = await db.query(`SELECT domain FROM ${S}.org_domains WHERE org_id = $1 ORDER BY domain`, [orgId]);
    return rows.map((r) => r.domain);
  }
  // Locks the company row: every domain/member/invite change for a company
  // goes through a queue, so "remove domain" and "accept invite" never cross
  // mid-flight. FOR NO KEY UPDATE (not FOR UPDATE): the usage write stamped
  // with the company (FK usage_events.org_id) takes FOR KEY SHARE on this
  // row, and the two don't block each other; otherwise every member's spend
  // would wait on any invite or domain change.
  const lockOrg = (db, orgId) => db.query(`SELECT id FROM ${S}.orgs WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
  async function adminDe(userId, db = pool) {
    const m = await membership(userId, db);
    if (!m) return erro(404, 'Você não faz parte de nenhuma empresa.');
    if (m.role !== 'admin') return erro(403, 'Só o administrador da empresa pode fazer isso.');
    return { ok: true, ...m };
  }

  // Connected e-mail accounts (Google/Microsoft) that are NOT from a domain on
  // the list. Microsoft with no known e-mail (connected before we started
  // storing it) comes back as `desconhecida`: there's no way to prove the
  // domain, so the caller treats it as outside.
  async function contasForaDoDominio(userId, doms, db = pool) {
    const fora = [];
    const g = await db.query(`SELECT google_email FROM ${S}.google_accounts WHERE user_id = $1`, [userId]);
    for (const r of g.rows) if (!noDominio(r.google_email, doms)) fora.push({ provider: 'google', email: r.google_email });
    const m = await db.query(
      `SELECT meta->>'account_email' AS email FROM ${S}.oauth_tokens WHERE user_id = $1 AND provider = 'microsoft' AND access_token IS NOT NULL`, [userId]);
    for (const r of m.rows) {
      if (!r.email) fora.push({ provider: 'microsoft', email: null, desconhecida: true });
      else if (!noDominio(r.email, doms)) fora.push({ provider: 'microsoft', email: r.email });
    }
    return fora;
  }
  const msgContasFora = (fora) => {
    const nomes = fora.map((f) => f.provider === 'google' ? `Google (${f.email})` : f.email ? `Microsoft (${f.email})` : 'Microsoft (conta não identificada)');
    return `Antes de entrar na empresa, desconecte as contas de e-mail de fora dos domínios da empresa: ${nomes.join(', ')}. Depois tente de novo.`;
  };

  return {
    init: () => pool.query(empresaSchemaSql(S)),
    ligar,
    contasForaDoDominio,
    linhaDoConvite: () => gancho.linhaDoConvite(),

    // E-mail of the connected Microsoft account, stored in the token's meta
    // (merges with whatever is already there, never overwrites the whole
    // meta). Serves the domain guard; the rest of the app doesn't read it.
    async gravarEmailMicrosoft(userId, email) {
      const em = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(em)) return;
      await pool.query(
        `UPDATE ${S}.oauth_tokens SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('account_email', $2::text)
          WHERE user_id = $1 AND provider = 'microsoft'`, [userId, em]);
    },
    async microsoftSemEmail(userId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ${S}.oauth_tokens WHERE user_id = $1 AND provider = 'microsoft' AND access_token IS NOT NULL
            AND COALESCE(meta->>'account_email', '') = ''`, [userId]);
      return rows.length > 0;
    },

    // Summary for /api/me and the screen: the person's company (or null) and
    // the pending invites for their e-mail. Whoever is already a member
    // doesn't see invites from another company.
    async resumo(user) {
      const m = await membership(user.id);
      if (m) return { empresa: { id: m.org_id, nome: m.name, papel: m.role, dominios: await dominios(m.org_id) }, convites: [] };
      const { rows } = await pool.query(
        `SELECT i.id, o.name AS empresa, i.created_at FROM ${S}.org_invites i JOIN ${S}.orgs o ON o.id = i.org_id
          WHERE i.email = $1 AND i.status = 'pending' ORDER BY i.created_at`, [String(user.email || '').toLowerCase()]);
      return { empresa: null, convites: rows.map((r) => ({ id: r.id, empresa: r.empresa, criado_em: r.created_at })) };
    },

    // Detail for the panel: domains, and (only for the admin) members and
    // pending invites. Whoever isn't a member receives the pending invites
    // for their e-mail.
    async detalhe(user) {
      const m = await membership(user.id);
      if (!m) return { empresa: null, convites: (await this.resumo(user)).convites };
      const out = { id: m.org_id, nome: m.name, papel: m.role, dominios: await dominios(m.org_id) };
      if (m.role === 'admin') {
        const mem = await pool.query(
          `SELECT u.id, u.name, u.email, m.role, m.joined_at FROM ${S}.org_members m JOIN ${S}.users u ON u.id = m.user_id
            WHERE m.org_id = $1 ORDER BY m.role, u.email`, [m.org_id]);
        out.membros = mem.rows.map((r) => ({ id: r.id, nome: r.name, email: r.email, papel: r.role, desde: r.joined_at }));
        const inv = await pool.query(
          `SELECT id, email, created_at FROM ${S}.org_invites WHERE org_id = $1 AND status = 'pending' ORDER BY created_at`, [m.org_id]);
        out.convites = inv.rows.map((r) => ({ id: r.id, email: r.email, criado_em: r.created_at }));
      }
      return { empresa: out };
    },

    // Turns the account into a company: creates the org, sets the person as
    // admin and already allows the domain of their login e-mail.
    async criar(user, nome) {
      const name = String(nome || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 80 || /[\u0000-\u001f]/.test(name)) return erro(400, 'Informe o nome da empresa (de 2 a 80 caracteres).');
      const dom = emailDomain(user.email);
      if (!dom) return erro(400, 'Não consegui ler o domínio do seu e-mail de login.');
      if (isPublicDomain(dom)) return erro(400, `Conta empresarial precisa de um e-mail do domínio da empresa. ${dom} é um provedor público; entre com o e-mail da empresa pra criar.`);
      const conflito = () => erro(409, 'Você já faz parte de uma empresa.');
      return transaction(async (c) => {
        // Person's credit guard before anything else (order: person, company),
        // and the user row: two simultaneous creations by the same person go
        // one at a time, and none of their reservations runs mid-account-swap.
        await lockCreditUser(c, user.id);
        await c.query(`SELECT id FROM ${S}.users WHERE id = $1 FOR UPDATE`, [user.id]);
        if (await membership(user.id, c)) return conflito();
        const fora = await contasForaDoDominio(user.id, [dom], c);
        if (fora.length) return erro(409, msgContasFora(fora), { contas_fora: fora });
        const { rows } = await c.query(`INSERT INTO ${S}.orgs (name, owner_user_id) VALUES ($1, $2) RETURNING id`, [name, user.id]);
        const orgId = rows[0].id;
        // ON CONFLICT: concurrent invite acceptance. Whoever arrives later
        // loses here (user_id is UNIQUE) and the whole transaction rolls back.
        const ins = await c.query(
          `INSERT INTO ${S}.org_members (org_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [orgId, user.id]);
        if (!ins.rows.length) throw Object.assign(new Error('já é membro'), { empresaConflito: true });
        await c.query(`INSERT INTO ${S}.org_domains (org_id, domain) VALUES ($1, $2)`, [orgId, dom]);
        // Newly created company: no one else holds its lock.
        await lockCreditOrg(c, orgId);
        await gancho.aoEntrar(c, { userId: user.id, orgId, origem: 'criar' });
        const planoPessoal = await gancho.aoCriar(c, { userId: user.id, orgId });
        return { ok: true, empresa: { id: orgId, nome: name, papel: 'admin', dominios: [dom] }, ...(planoPessoal ? { planoPessoal } : {}) };
      }).then((out) => aposEntrada(out, { userId: user.id, orgId: out?.empresa?.id, origem: 'criar' }))
        .catch((e) => {
          if (e?.empresaConflito) return conflito();
          if (e?.empresaErro) return e.empresaErro;
          throw e;
        });
    },

    async adicionarDominio(userId, dominio) {
      const d = normalizeDomain(dominio);
      if (!d) return erro(400, 'Domínio inválido. Use só o domínio, por exemplo: empresa.com.br');
      if (isPublicDomain(d)) return erro(400, `${d} é um provedor de e-mail público e não pode entrar na lista da empresa.`);
      return transaction(async (c) => {
        const a = await adminDe(userId, c); if (!a.ok) return a;
        await lockOrg(c, a.org_id);
        await c.query(`INSERT INTO ${S}.org_domains (org_id, domain) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a.org_id, d]);
        return { ok: true, dominios: await dominios(a.org_id, c) };
      });
    },

    // Point 7: a domain that still has a member or a pending invite does NOT
    // come off the list. Forcing it off would leave a member "outside" while
    // inside the company, with Google/Microsoft connections the guard would
    // no longer accept. The admin removes the members and revokes that
    // domain's invites first.
    async removerDominio(userId, dominio) {
      const d = normalizeDomain(dominio);
      if (!d) return erro(400, 'Domínio inválido.');
      return transaction(async (c) => {
        const a = await adminDe(userId, c); if (!a.ok) return a;
        await lockOrg(c, a.org_id);
        const doms = await dominios(a.org_id, c);
        if (!doms.includes(d)) return erro(404, 'Esse domínio não está na lista da empresa.');
        const mem = await c.query(
          `SELECT u.email FROM ${S}.org_members m JOIN ${S}.users u ON u.id = m.user_id WHERE m.org_id = $1`, [a.org_id]);
        const nMem = mem.rows.filter((r) => emailDomain(r.email) === d).length;
        const inv = await c.query(`SELECT email FROM ${S}.org_invites WHERE org_id = $1 AND status = 'pending'`, [a.org_id]);
        const nInv = inv.rows.filter((r) => emailDomain(r.email) === d).length;
        if (nMem || nInv) {
          const partes = [nMem && `${nMem} membro(s)`, nInv && `${nInv} convite(s) pendente(s)`].filter(Boolean).join(' e ');
          return erro(409, `O domínio ${d} ainda tem ${partes}. Remova os membros e revogue os convites desse domínio antes de tirá-lo da lista.`, { membros: nMem, convites: nInv });
        }
        await c.query(`DELETE FROM ${S}.org_domains WHERE org_id = $1 AND domain = $2`, [a.org_id, d]);
        return { ok: true, dominios: await dominios(a.org_id, c) };
      });
    },

    // Invite. Paid-plan notice: if the e-mail already has an account with an
    // ACTIVE paid personal plan, the invite is created anyway, but the admin
    // is told the person can only accept after cancelling it.
    async convidar(userId, email) {
      const em = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(em) || em.length > 254) return erro(400, 'E-mail inválido.');
      return transaction(async (c) => {
        const a = await adminDe(userId, c); if (!a.ok) return a;
        await lockOrg(c, a.org_id);
        const doms = await dominios(a.org_id, c);
        if (!noDominio(em, doms)) return erro(400, `Só dá pra convidar e-mail dos domínios da empresa (${doms.join(', ')}). Adicione o domínio na lista primeiro.`);
        const u = await c.query(`SELECT id FROM ${S}.users WHERE email = $1 AND deleted_at IS NULL`, [em]);
        const alvo = u.rows[0];
        if (alvo) {
          const jaAqui = await c.query(`SELECT 1 FROM ${S}.org_members WHERE org_id = $1 AND user_id = $2`, [a.org_id, alvo.id]);
          if (jaAqui.rows.length) return erro(409, 'Essa pessoa já faz parte da empresa.');
        }
        const existente = await c.query(`SELECT id, created_at FROM ${S}.org_invites WHERE org_id = $1 AND email = $2 AND status = 'pending'`, [a.org_id, em]);
        const convite = existente.rows[0] || (await c.query(
          `INSERT INTO ${S}.org_invites (org_id, email, invited_by) VALUES ($1, $2, $3) RETURNING id, created_at`, [a.org_id, em, userId])).rows[0];
        const out = { ok: true, convite: { id: convite.id, email: em, criado_em: convite.created_at }, ja_existia: !!existente.rows[0], empresa: a.name };
        const aviso = alvo ? await gancho.avisoAoConvidar(alvo.id) : null;
        if (aviso) out.aviso = aviso;
        // The invite e-mail goes out in the route, after the commit
        // (empresa-convite-email.mjs).
        return out;
      });
    },

    // Pending invite for the email: goes through the beta waitlist at signup.
    async temConvitePendente(email) {
      const em = String(email || '').trim().toLowerCase();
      if (!em) return false;
      const { rows } = await pool.query(`SELECT 1 FROM ${S}.org_invites WHERE email = $1 AND status = 'pending' LIMIT 1`, [em]);
      return rows.length > 0;
    },

    async revogarConvite(userId, conviteId) {
      return transaction(async (c) => {
        const a = await adminDe(userId, c); if (!a.ok) return a;
        await lockOrg(c, a.org_id);
        const { rows } = await c.query(
          `UPDATE ${S}.org_invites SET status = 'revoked', responded_at = now()
            WHERE id::text = $1 AND org_id = $2 AND status = 'pending' RETURNING id`, [String(conviteId || ''), a.org_id]);
        return rows.length ? { ok: true } : erro(404, 'Convite não encontrado ou já respondido.');
      });
    },

    // The invitee's response. Accepting has gates, in this order: the invite
    // is theirs and is pending; they aren't in another company; their domain
    // is still on the list; they have no active paid personal plan; and no
    // connected Google/Microsoft account is outside the domains (point 6:
    // doesn't come in "dirty").
    async responder(user, conviteId, aceitar) {
      const em = String(user.email || '').toLowerCase();
      const id = String(conviteId || '');
      const { rows: pre } = await pool.query(`SELECT org_id FROM ${S}.org_invites WHERE id::text = $1`, [id]);
      if (!pre[0]) return erro(404, 'Convite não encontrado.');
      return transaction(async (c) => {
        // Credit guards (person, then the invite's company) before the
        // company row. An invite's org_id never changes, so reading it
        // outside still holds.
        await lockCreditUser(c, user.id);
        await lockCreditOrg(c, pre[0].org_id);
        await lockOrg(c, pre[0].org_id);
        const { rows } = await c.query(`SELECT * FROM ${S}.org_invites WHERE id::text = $1 FOR UPDATE`, [id]);
        const inv = rows[0];
        if (!inv || inv.email !== em) return erro(404, 'Convite não encontrado.');
        if (inv.status !== 'pending') return erro(409, 'Esse convite não está mais valendo.');
        if (!aceitar) {
          await c.query(`UPDATE ${S}.org_invites SET status = 'declined', responded_at = now() WHERE id = $1`, [inv.id]);
          return { ok: true, aceito: false };
        }
        if (await membership(user.id, c)) return erro(409, 'Você já faz parte de uma empresa. Uma conta participa de uma empresa só.');
        const doms = await dominios(inv.org_id, c);
        if (!noDominio(em, doms)) return erro(409, 'O domínio do seu e-mail não está mais liberado nessa empresa. Fale com o administrador.');
        const barra = await gancho.impedeEntrada(user.id);
        if (barra) return erro(409, barra.error, barra.code ? { code: barra.code } : {});
        const fora = await contasForaDoDominio(user.id, doms, c);
        if (fora.length) return erro(409, msgContasFora(fora), { code: 'contas_fora', contas_fora: fora });
        const ins = await c.query(
          `INSERT INTO ${S}.org_members (org_id, user_id, role) VALUES ($1, $2, 'membro') ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [inv.org_id, user.id]);
        if (!ins.rows.length) return erro(409, 'Você já faz parte de uma empresa. Uma conta participa de uma empresa só.');
        await c.query(`UPDATE ${S}.org_invites SET status = 'accepted', responded_at = now() WHERE id = $1`, [inv.id]);
        await gancho.aoEntrar(c, { userId: user.id, orgId: inv.org_id, origem: 'convite' });
        const { rows: o } = await c.query(`SELECT name FROM ${S}.orgs WHERE id = $1`, [inv.org_id]);
        return { ok: true, aceito: true, empresa: { id: inv.org_id, nome: o[0]?.name, papel: 'membro', dominios: doms } };
      }).then((out) => aposEntrada(out, { userId: user.id, orgId: out?.empresa?.id, origem: 'convite' }));
    },

    async removerMembro(adminId, membroId) {
      if (String(membroId) === String(adminId)) return erro(400, 'O administrador não pode se remover da empresa.');
      const pre = await membership(adminId);
      if (!pre) return adminDe(adminId);
      const membro = String(membroId || '');
      return transaction(async (c) => {
        // Credit guards (whoever is leaving, then the company) before the
        // company row. The admin's company was read outside; if it changed by
        // now, the adminDe check below won't match it and nothing is removed.
        await lockCreditUser(c, membro);
        await lockCreditOrg(c, pre.org_id);
        const a = await adminDe(adminId, c); if (!a.ok) return a;
        if (a.org_id !== pre.org_id) return erro(409, 'A empresa mudou no meio da operação. Tente de novo.');
        await lockOrg(c, a.org_id);
        const { rows } = await c.query(
          `DELETE FROM ${S}.org_members WHERE org_id = $1 AND user_id::text = $2 AND role <> 'admin' RETURNING user_id`, [a.org_id, membro]);
        return rows.length ? { ok: true } : erro(404, 'Membro não encontrado.');
      });
    },

    // Only to decide whether it's worth reading the connected account's e-mail.
    async ehMembro(userId) { return !!(await membership(userId)); },

    // Point 6, at CONNECT time: a member can only connect Google/Microsoft
    // from a domain on the list. A non-member passes straight through (no
    // change).
    async conexaoPermitida(userId, email) {
      const m = await membership(userId);
      if (!m) return { ok: true };
      const doms = await dominios(m.org_id);
      if (email && noDominio(email, doms)) return { ok: true };
      return { ok: false, empresa: m.name, dominios: doms, email: email || null };
    },
  };
}
