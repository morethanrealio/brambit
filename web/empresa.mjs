// Conta empresarial, Fases F0 e F1 (docs: projetos/conta-empresarial.md).
//
// O que existe aqui: a empresa (org), a lista de domínios liberados, os membros
// e os convites. Desde a F1 a empresa também tem plano e saldo de crédito
// próprios, divididos por todos os membros (a conta do saldo é a mesma da
// pessoa, em credit-status.mjs); as colunas e tabelas dessa cobrança moram na
// nuvem (empresaCobrancaSchemaSql, org-billing.mjs). Quem não é de empresa
// nenhuma não passa por nada disto.
//
// Travas (F1): entrar, criar e sair mexem em QUAL conta paga o consumo da
// pessoa, então pegam as mesmas travas da reserva de crédito, na mesma ordem
// (pessoa, depois empresa; travas-de-conta.mjs) e ANTES da trava de
// linha da empresa. Assim nenhuma reserva fica no meio de uma troca de conta.
//
// Regras que vêm das decisões do Marcos (msgs 7758 e 7760):
// - Uma pessoa está em no máximo UMA empresa (UNIQUE em org_members.user_id).
// - Domínio não é único no sistema: duas empresas podem listar o mesmo domínio
//   (não há prova por DNS). O que é único é (empresa, domínio).
// - Entra só por convite, e o e-mail convidado tem que ser de um domínio da lista.
// - Quem instala pode barrar a entrada (impedeEntrada; no Brambs, conta com plano
//   pessoal pago ativo precisa cancelar antes de aceitar o convite).
// - Membro só conecta Google/Microsoft de domínio da lista; conector sem e-mail
//   (WhatsApp, Telegram, GitHub, Notion, Slack, chave de API, MCP) fica livre.
//
// Sem conexão/import de db aqui: o db.mjs injeta o pool e os testes usam PGlite
// com as mesmas funções. O que é de cobrança (plano pago, pacotes, reembolso)
// entra pelos ganchos abaixo, ligados pela nuvem (empresa-brambs.mjs); na versão
// aberta nenhum é ligado e a empresa é só membros, domínios e convites.

import { lockCreditUser, lockCreditOrg } from './travas-de-conta.mjs';

// Provedores de e-mail público: não identificam empresa nenhuma, então não
// entram na lista de domínios e não servem pra criar empresa. Lista curta de
// propósito (os grandes do Brasil e de fora); `yahoo.*` cobre os regionais.
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

// Domínio em forma canônica: minúsculo, sem espaço, sem "@" na frente e sem
// ponto no fim. Devolve '' se não for um domínio válido.
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

// Comparação EXATA: sub.empresa.com.br não vale por empresa.com.br. Quem usa
// subdomínio cadastra o subdomínio.
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

// deps: S (schema, padrão mtr_harness) e os ganchos, que também podem ser
// ligados depois com store.ligar({...}):
//  - avisoAoConvidar(userId): texto (ou null) que vai no `aviso` do convite
//    quando o e-mail convidado já tem conta.
//  - impedeEntrada(userId): { error, code? } (ou null) que barra o aceite do
//    convite com 409.
//  - aoEntrar(client, { userId, orgId, origem }): roda na transação de quem
//    acabou de virar membro, com as travas de crédito tomadas. origem é
//    'criar' (quem cria a empresa) ou 'convite' (quem aceita convite).
//  - aoCriar(client, { userId, orgId }): só na criação, depois do aoEntrar e
//    na mesma transação. Encerra o plano pessoal do criador (org-billing.mjs:
//    pessoa no Free, sobra do plano como crédito extra da empresa, assinatura
//    marcada pra cancelar) e devolve { sobra, sobraVenceEm, cancelaAssinatura }
//    quando havia plano, que o criar devolve em `planoPessoal`. Erro com
//    `empresaErro` desfaz tudo e vira a resposta.
//  - depoisDeEntrar({ userId, orgId, origem }): roda DEPOIS do commit da
//    entrada (convite: reembolso no Stripe do pacote pago do convidado,
//    org-join-refund.mjs; criar: cancelamento da assinatura pessoal do
//    criador, org-billing.mjs). Falha dela só é logada: a entrada já valeu, e
//    o que não saiu fica pendente pra nova tentativa.
//  - linhaDoConvite(): frase (ou null) sobre como a conta da empresa funciona
//    pra quem instala, que vai no e-mail do convite (empresa-convite-email.mjs).
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
    catch (e) { console.error(`[empresa] pós-entrada falhou user=${ctx.userId} org=${ctx.orgId}: ${e?.message ?? e}`); }
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
  // Tranca a linha da empresa: toda mudança de domínio/membro/convite de uma
  // empresa passa em fila, então "tirar domínio" e "aceitar convite" nunca se
  // cruzam no meio. FOR NO KEY UPDATE (e não FOR UPDATE): a gravação de uso
  // carimbada com a empresa (FK usage_events.org_id) pega FOR KEY SHARE nesta
  // linha, e as duas não se bloqueiam; senão todo gasto de membro esperaria
  // qualquer mudança de convite ou domínio.
  const lockOrg = (db, orgId) => db.query(`SELECT id FROM ${S}.orgs WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
  async function adminDe(userId, db = pool) {
    const m = await membership(userId, db);
    if (!m) return erro(404, 'Você não faz parte de nenhuma empresa.');
    if (m.role !== 'admin') return erro(403, 'Só o administrador da empresa pode fazer isso.');
    return { ok: true, ...m };
  }

  // Contas de e-mail conectadas (Google/Microsoft) que NÃO são de um domínio da
  // lista. Microsoft sem e-mail conhecido (conectada antes de guardarmos o
  // e-mail) volta como `desconhecida`: não dá pra provar o domínio, então quem
  // chama trata como fora.
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

    // E-mail da conta Microsoft conectada, guardado no meta do token (junta com
    // o que já houver, nunca sobrescreve o meta inteiro). Serve à trava de
    // domínio; o resto do app não lê.
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

    // Resumo pra /api/me e pra tela: a empresa da pessoa (ou null) e os convites
    // pendentes pro e-mail dela. Quem já é membro não vê convite de outra empresa.
    async resumo(user) {
      const m = await membership(user.id);
      if (m) return { empresa: { id: m.org_id, nome: m.name, papel: m.role, dominios: await dominios(m.org_id) }, convites: [] };
      const { rows } = await pool.query(
        `SELECT i.id, o.name AS empresa, i.created_at FROM ${S}.org_invites i JOIN ${S}.orgs o ON o.id = i.org_id
          WHERE i.email = $1 AND i.status = 'pending' ORDER BY i.created_at`, [String(user.email || '').toLowerCase()]);
      return { empresa: null, convites: rows.map((r) => ({ id: r.id, empresa: r.empresa, criado_em: r.created_at })) };
    },

    // Detalhe pro painel: domínios, e (só pro admin) membros e convites pendentes.
    // Quem não é membro recebe os convites pendentes pro e-mail dele.
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

    // Transforma a conta em empresa: cria a org, põe a pessoa como admin e já
    // libera o domínio do e-mail de login dela.
    async criar(user, nome) {
      const name = String(nome || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 80 || /[\u0000-\u001f]/.test(name)) return erro(400, 'Informe o nome da empresa (de 2 a 80 caracteres).');
      const dom = emailDomain(user.email);
      if (!dom) return erro(400, 'Não consegui ler o domínio do seu e-mail de login.');
      if (isPublicDomain(dom)) return erro(400, `Conta empresarial precisa de um e-mail do domínio da empresa. ${dom} é um provedor público; entre com o e-mail da empresa pra criar.`);
      const conflito = () => erro(409, 'Você já faz parte de uma empresa.');
      return transaction(async (c) => {
        // Trava de crédito da pessoa antes de tudo (ordem pessoa, empresa), e a
        // linha do usuário: duas criações simultâneas da mesma pessoa passam uma
        // de cada vez, e nenhuma reserva dela corre no meio da troca de conta.
        await lockCreditUser(c, user.id);
        await c.query(`SELECT id FROM ${S}.users WHERE id = $1 FOR UPDATE`, [user.id]);
        if (await membership(user.id, c)) return conflito();
        const fora = await contasForaDoDominio(user.id, [dom], c);
        if (fora.length) return erro(409, msgContasFora(fora), { contas_fora: fora });
        const { rows } = await c.query(`INSERT INTO ${S}.orgs (name, owner_user_id) VALUES ($1, $2) RETURNING id`, [name, user.id]);
        const orgId = rows[0].id;
        // ON CONFLICT: aceite de convite concorrente. Quem chegou depois perde
        // aqui (user_id é UNIQUE) e a transação inteira volta.
        const ins = await c.query(
          `INSERT INTO ${S}.org_members (org_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [orgId, user.id]);
        if (!ins.rows.length) throw Object.assign(new Error('já é membro'), { empresaConflito: true });
        await c.query(`INSERT INTO ${S}.org_domains (org_id, domain) VALUES ($1, $2)`, [orgId, dom]);
        // Empresa recém-criada: ninguém mais tem a trava dela.
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

    // Ponto 7: domínio que ainda tem membro ou convite pendente NÃO sai da
    // lista. Tirar à força deixaria membro "de fora" dentro da empresa, com
    // Google/Microsoft conectados que a trava não aceitaria mais. O admin remove
    // os membros e revoga os convites daquele domínio primeiro.
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

    // Convite. Aviso de plano pago: se o e-mail já tem conta com plano pessoal
    // pago ATIVO, o convite é criado mesmo assim, mas o admin fica sabendo que a
    // pessoa só consegue aceitar depois de cancelar.
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
        // O e-mail do convite sai na rota, depois do commit (empresa-convite-email.mjs).
        return out;
      });
    },

    // Convite pendente pro e-mail: passa pela fila de espera do beta no cadastro.
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

    // Resposta do convidado. Aceitar tem portões, nesta ordem: o convite é dele
    // e está pendente; ele não está em outra empresa; o domínio dele segue na
    // lista; ele não tem plano pessoal pago ativo; e nenhuma conta Google/Microsoft
    // conectada é de fora dos domínios (ponto 6: não entra "sujo").
    async responder(user, conviteId, aceitar) {
      const em = String(user.email || '').toLowerCase();
      const id = String(conviteId || '');
      const { rows: pre } = await pool.query(`SELECT org_id FROM ${S}.org_invites WHERE id::text = $1`, [id]);
      if (!pre[0]) return erro(404, 'Convite não encontrado.');
      return transaction(async (c) => {
        // Travas de crédito (pessoa, depois a empresa do convite) antes da linha
        // da empresa. org_id de um convite não muda, então a leitura de fora vale.
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
        // Travas de crédito (quem sai, depois a empresa) antes da linha da
        // empresa. A empresa do admin foi lida fora; se mudou até aqui, o
        // adminDe abaixo não fecha com ela e nada é removido.
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

    // Só pra decidir se vale o trabalho de ler o e-mail da conta conectada.
    async ehMembro(userId) { return !!(await membership(userId)); },

    // Ponto 6, na hora de CONECTAR: quem é membro só conecta Google/Microsoft de
    // domínio da lista. Quem não é membro passa direto (nenhuma mudança).
    async conexaoPermitida(userId, email) {
      const m = await membership(userId);
      if (!m) return { ok: true };
      const doms = await dominios(m.org_id);
      if (email && noDominio(email, doms)) return { ok: true };
      return { ok: false, empresa: m.name, dominios: doms, email: email || null };
    },
  };
}
