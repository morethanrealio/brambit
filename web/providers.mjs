import { microsoftOnboardingScope } from './microsoft-scopes.mjs';
import crypto from 'node:crypto';

// ── Conectores OAuth genéricos (GitHub, Slack, e o que vier) ──
// Mesmo padrão do Google (auth.mjs), mas num registry: pra adicionar um serviço
// novo basta uma entrada aqui + as tools dele em connectors-ext.mjs. O token é
// guardado por (usuário, provider) em mtr_harness.oauth_tokens.
//
// GitHub e Slack devolvem tokens que NÃO expiram (sem refresh), então o fluxo é
// simples: authorize -> troca o code -> guarda o access_token.

const PROVIDERS = {
  github: {
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // repo (issues/PRs/código, público e privado) + identidade.
    scope: 'repo read:user read:org',
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
    redirectUri: () => process.env.GITHUB_REDIRECT_URI,
    extraAuth: { allow_signup: 'false' },
    parseToken: (j) => {
      if (j.error) throw new Error(`github oauth: ${j.error_description || j.error}`);
      return { access_token: j.access_token, refresh_token: null, scope: j.scope || '', expiry: null };
    },
  },
  slack: {
    label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // Token de USUÁRIO (o assistente age como a pessoa): vai em user_scope.
    scope: '', // sem escopos de bot
    userScope: 'search:read channels:history channels:read groups:history groups:read im:history im:read im:write mpim:history mpim:read mpim:write chat:write users:read',
    clientId: () => process.env.SLACK_CLIENT_ID,
    clientSecret: () => process.env.SLACK_CLIENT_SECRET,
    redirectUri: () => process.env.SLACK_REDIRECT_URI,
    parseToken: (j) => {
      if (!j.ok) throw new Error(`slack oauth: ${j.error || 'falhou'}`);
      const u = j.authed_user || {};
      return { access_token: u.access_token, refresh_token: null, scope: u.scope || '', expiry: null };
    },
  },
  nuvemshop: {
    label: 'Nuvemshop',
    // OAuth da Nuvemshop/Tiendanube foge do genérico: o app_id vai no PATH da URL
    // de autorização (escopos e redirect são definidos no painel do app), e a troca
    // do code é em JSON, sem redirect_uri. Por isso usa os hooks buildAuthUrl/exchange.
    clientId: () => process.env.NUVEMSHOP_CLIENT_ID, // = App ID
    clientSecret: () => process.env.NUVEMSHOP_CLIENT_SECRET,
    redirectUri: () => process.env.NUVEMSHOP_REDIRECT_URI, // registrado no painel; usado só p/ derivar a home
    buildAuthUrl: (p, state) =>
      `https://www.tiendanube.com/apps/${p.clientId()}/authorize?state=${encodeURIComponent(state)}`,
    exchange: async (p, code) => {
      const r = await fetch('https://www.tiendanube.com/apps/authorize/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: p.clientId(),
          client_secret: p.clientSecret(),
          grant_type: 'authorization_code',
          code,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        throw new Error(`nuvemshop token ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      }
      // user_id = id da loja (store_id), guardado no meta pra montar a base da API.
      return {
        access_token: j.access_token,
        refresh_token: null,
        scope: j.scope || '',
        expiry: null,
        meta: { store_id: String(j.user_id) },
      };
    },
  },
  microsoft: {
    label: 'Hotmail/Outlook',
    // Hotmail/Outlook.com = conta Microsoft -> Microsoft Graph via OAuth (Entra ID).
    // O tenant /common/ aceita conta pessoal (Hotmail/Outlook) E corporativa.
    // Diferente de GitHub/Slack, o access_token EXPIRA (~1h): precisa de refresh_token
    // (escopo offline_access). O refresh é tratado em validProviderToken (server.mjs)
    // via providerRefresh() abaixo.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // offline_access = refresh_token; User.Read = identidade; Mail.Read/Send = e-mail;
    // Calendars.ReadWrite = agenda do Outlook (ler/criar/editar/apagar evento);
    // Files.ReadWrite = OneDrive do usuário (ler, buscar e subir arquivo).
    // Files.ReadWrite é o MENOS privilegiado que serve: vale só pro drive DA
    // PESSOA, NÃO exige consentimento de admin e funciona em conta pessoal
    // (Hotmail/Outlook.com). Os primos `.All` (Files.Read.All/Files.ReadWrite.All)
    // alcançam arquivos compartilhados e SharePoint, mas exigem admin e não
    // existem em conta pessoal — por isso ficam de fora de propósito.
    // OBS: usuários que conectaram ANTES de uma linha destas não têm o escopo novo
    // no token; precisam reconectar (clicar em conectar Outlook de novo) pra a
    // Microsoft pedir o consentimento incremental. Sem isso, as tools do escopo
    // que faltou devolvem 403 até a reconexão (as tools do OneDrive detectam isso
    // pelo `scope` guardado e já respondem pedindo a reconexão, sem chamar a API).
    scope: 'openid offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.ReadWrite',
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri: () => process.env.MICROSOFT_REDIRECT_URI,
    // Microsoft exige response_type explícito; select_account deixa o usuário escolher
    // qual conta Microsoft usar.
    extraAuth: { response_type: 'code', response_mode: 'query', prompt: 'select_account' },
    parseToken: (j) => {
      if (j.error) throw new Error(`microsoft oauth: ${j.error_description || j.error}`);
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        scope: j.scope || '',
        expiry: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000),
      };
    },
    // Renova o access_token usando o refresh_token. A Microsoft PODE devolver um
    // refresh_token novo (rotação); parseToken preserva o antigo se vier null e o
    // saveOAuthToken faz COALESCE, então nunca perdemos o refresh.
    refresh: async (p, refreshToken) => {
      const body = new URLSearchParams({
        client_id: p.clientId(),
        client_secret: p.clientSecret(),
        redirect_uri: p.redirectUri(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        // Omit scope: retain the original grant instead of requesting mail/files.
      });
      const r = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      if (!r.ok) throw new Error(`microsoft refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return p.parseToken(await r.json());
    },
  },
  notion: {
    label: 'Notion',
    // O Notion já funcionava pelo Cofre (o usuário criava uma integração interna,
    // copiava o "Internal Integration Secret" e ainda tinha que liberar página por
    // página no ••• › Connections). Continua funcionando; isto aqui é o caminho de
    // um clique. O ganho não é só pular o token: na tela de consentimento do Notion
    // o próprio usuário escolhe no page picker o que a integração enxerga, então a
    // liberação por página some junto.
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    // Escopo não vai na URL: quem define a capacidade é a configuração da
    // integração no painel do Notion, e o recorte de conteúdo é o page picker.
    scope: '',
    clientId: () => process.env.NOTION_CLIENT_ID,
    clientSecret: () => process.env.NOTION_CLIENT_SECRET,
    redirectUri: () => process.env.NOTION_REDIRECT_URI,
    // owner=user é obrigatório no fluxo público.
    extraAuth: { response_type: 'code', owner: 'user' },
    parseToken: (j) => {
      if (j.error) throw new Error(`notion oauth: ${j.error_description || j.error}`);
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        scope: '',
        // Token do Notion não expira por padrão; só quando a integração liga
        // expiração no painel é que vem expires_in + refresh_token. Guardamos a
        // validade só nesse caso, senão null (= não expira) e nada a renovar.
        expiry: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000) : null,
        meta: {
          workspace_id: j.workspace_id || null,
          workspace_name: j.workspace_name || null,
          bot_id: j.bot_id || null,
        },
      };
    },
    // A troca foge do genérico em dois pontos: as credenciais do app vão em HTTP
    // Basic (não no corpo) e o corpo é JSON.
    exchange: async (p, code) => {
      const basic = Buffer.from(`${p.clientId()}:${p.clientSecret()}`).toString('base64');
      const r = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        throw new Error(`notion token ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      }
      return p.parseToken(j);
    },
    // Só entra em cena se a integração estiver com expiração ligada.
    refresh: async (p, refreshToken) => {
      const basic = Buffer.from(`${p.clientId()}:${p.clientSecret()}`).toString('base64');
      const r = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      if (!r.ok) throw new Error(`notion refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return p.parseToken(await r.json());
    },
  },
  linkedin: {
    label: 'LinkedIn',
    // OAuth 2.0 3-legged padrão (form-urlencoded), igual GitHub/Microsoft.
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    // Escopo default: identidade (OpenID Connect) + publicar em nome do membro.
    //  • openid profile  → produto "Sign In with LinkedIn using OpenID Connect"
    //    (userinfo devolve o `sub` = id do membro, necessário pra montar o author URN)
    //  • w_member_social → produto "Share on LinkedIn" (postar/comentar)
    // Se o app do usuário só tiver um desses produtos aprovados, ajustar via env
    // LINKEDIN_SCOPE sem mexer no código (ex.: só "w_member_social").
    scope: process.env.LINKEDIN_SCOPE || 'openid profile w_member_social',
    clientId: () => process.env.LINKEDIN_CLIENT_ID,
    clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri: () => process.env.LINKEDIN_REDIRECT_URI,
    // LinkedIn exige response_type explícito.
    extraAuth: { response_type: 'code' },
    // O access_token do LinkedIn EXPIRA (~60 dias). refresh_token só existe pra
    // apps aprovados no programa de refresh; se não vier, guardamos null e o
    // usuário reconecta ao expirar (validProviderToken avisa).
    parseToken: (j) => {
      if (j.error) throw new Error(`linkedin oauth: ${j.error_description || j.error}`);
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        scope: j.scope || '',
        expiry: new Date(Date.now() + (Number(j.expires_in) || 5184000) * 1000),
      };
    },
    // Troca padrão do code + busca o id do membro (author URN) e guarda no meta,
    // no mesmo espírito do store_id da Nuvemshop. Tenta OpenID (userinfo) e cai
    // pro endpoint legado /v2/me se o app usar r_liteprofile. Se nenhum der (só
    // w_member_social liberado), guarda o token mesmo assim e a tool de post
    // resolve o URN na hora (ou explica qual escopo falta).
    exchange: async (p, code) => {
      const body = new URLSearchParams({
        code,
        client_id: p.clientId(),
        client_secret: p.clientSecret(),
        redirect_uri: p.redirectUri(),
        grant_type: 'authorization_code',
      });
      const r = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        throw new Error(`linkedin token ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      }
      const tok = p.parseToken(j);
      const who = await linkedinIdentity(tok.access_token).catch(() => null);
      if (who) tok.meta = { member_urn: who.urn, member_name: who.name || null };
      return tok;
    },
    // Renova o access_token se o app tiver refresh_token habilitado (rotação).
    refresh: async (p, refreshToken) => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: p.clientId(),
        client_secret: p.clientSecret(),
      });
      const r = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      if (!r.ok) throw new Error(`linkedin refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return p.parseToken(await r.json());
    },
  },
  canva: {
    label: 'Canva',
    // A Canva entra pelo servidor MCP dela (https://mcp.canva.com/mcp), que é o
    // próprio authorization server (OAuth 2.1). Duas diferenças em relação aos
    // outros conectores daqui:
    //  • PKCE OBRIGATÓRIO (code_challenge S256 na authorize, code_verifier na
    //    troca). É o que `pkce: true` liga no caminho genérico abaixo.
    //  • o client NÃO foi criado num painel: veio de Dynamic Client Registration
    //    (POST https://mcp.canva.com/register, aberto e sem auth). O client_id/
    //    secret que saíram de lá vivem no .env, como qualquer outro provider.
    // O access_token expira (~1h) e vem com refresh_token; a renovação sai de
    // graça no validProviderToken (server.mjs), igual à Microsoft.
    authUrl: 'https://mcp.canva.com/authorize',
    tokenUrl: 'https://mcp.canva.com/token',
    pkce: true,
    // Escopos pedidos (dos 16 que o servidor anuncia). De fora de propósito:
    // brandtemplate:* e brandkit:read (exigem Canva Pro/Enterprise) e
    // help:answers:* (central de ajuda, não é o caso de uso). ⚠️ Ampliar esta
    // lista obriga TODO mundo que já conectou a reconectar pra o consentimento
    // novo valer (mesma lição do Calendars.ReadWrite no Outlook).
    scope: process.env.CANVA_SCOPE
      || 'profile:read design:meta:read design:content:read design:content:write folder:read folder:write asset:read asset:write comment:read comment:write',
    clientId: () => process.env.CANVA_CLIENT_ID,
    clientSecret: () => process.env.CANVA_CLIENT_SECRET,
    redirectUri: () => process.env.CANVA_REDIRECT_URI,
    extraAuth: { response_type: 'code' },
    parseToken: (j) => {
      if (j.error) throw new Error(`canva oauth: ${j.error_description || j.error}`);
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        scope: j.scope || '',
        expiry: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000),
      };
    },
    // O client foi registrado com token_endpoint_auth_method=client_secret_basic,
    // então as credenciais vão no header Authorization (não no corpo), e o
    // code_verifier acompanha a troca.
    exchange: async (p, code, opts = {}) => {
      const body = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: p.redirectUri(),
        client_id: p.clientId(),
      });
      if (opts.codeVerifier) body.set('code_verifier', opts.codeVerifier);
      return canvaToken(p, body, 'token');
    },
    refresh: async (p, refreshToken) => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: p.clientId(),
      });
      return canvaToken(p, body, 'refresh');
    },
  },
};

// Chamada ao /token da Canva com Basic auth (client_secret_basic).
async function canvaToken(p, body, tag) {
  const basic = Buffer.from(`${p.clientId()}:${p.clientSecret()}`).toString('base64');
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: `Basic ${basic}`,
    },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`canva ${tag} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return p.parseToken(j);
}

// Descobre o id do membro logado pra montar o author URN (urn:li:person:<id>).
// OpenID Connect: GET /v2/userinfo -> { sub, name }. Legado (r_liteprofile):
// GET /v2/me -> { id }. Exportada porque as tools também usam no fallback lazy.
export async function linkedinIdentity(accessToken) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const oidc = await fetch('https://api.linkedin.com/v2/userinfo', { headers: auth });
  if (oidc.ok) {
    const j = await oidc.json();
    if (j.sub) return { urn: `urn:li:person:${j.sub}`, name: j.name || null };
  }
  const me = await fetch('https://api.linkedin.com/v2/me', { headers: auth });
  if (me.ok) {
    const j = await me.json();
    if (j.id) return { urn: `urn:li:person:${j.id}`, name: null };
  }
  return null;
}

// E-mail da conta Microsoft conectada (conta empresarial: trava de domínio).
// GET /me do Graph com o escopo User.Read, que o conector JÁ pede (nenhum escopo
// novo). `mail` é o endereço de e-mail; conta pessoal (Hotmail/Outlook.com) às
// vezes vem sem `mail`, e aí o nome de login (userPrincipalName) é o próprio
// e-mail. Devolve null se não der pra saber: quem chama decide o que fazer.
export async function microsoftAccountEmail(accessToken, { timeoutMs = 8000 } = {}) {
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    const email = String(j.mail || j.userPrincipalName || '').trim().toLowerCase();
    return /^[^@\s#]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
  } catch { return null; }
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export const providerEnabled = (name) => {
  const p = PROVIDERS[name];
  return !!(p && p.clientId() && p.clientSecret() && p.redirectUri());
};

// ── PKCE (RFC 7636), exigido pelo OAuth 2.1 do MCP ──
// Quem liga é o provider, com `pkce: true`. O verifier é sorteado no /start e
// viaja num cookie próprio até o /callback; só o desafio (S256) vai pra URL.
export const providerUsesPkce = (name) => !!PROVIDERS[name]?.pkce;

export const newPkceVerifier = () => crypto.randomBytes(32).toString('base64url');

export const pkceChallenge = (verifier) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

// URL pra onde mandamos o usuário autorizar. `state` protege CSRF.
// `opts.codeVerifier` (quando o provider usa PKCE) vira code_challenge S256.
export function providerAuthUrl(name, state, opts = {}) {
  const p = PROVIDERS[name];
  if (p.buildAuthUrl) return p.buildAuthUrl(p, state, opts);
  const params = new URLSearchParams({ client_id: p.clientId(), redirect_uri: p.redirectUri(), state });
  if (p.scope) params.set('scope', name === 'microsoft' && opts.services !== undefined ? microsoftOnboardingScope(opts.services) : p.scope);
  if (p.userScope) params.set('user_scope', p.userScope);
  if (p.pkce && opts.codeVerifier) {
    params.set('code_challenge', pkceChallenge(opts.codeVerifier));
    params.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(p.extraAuth || {})) params.set(k, v);
  return `${p.authUrl}?${params.toString()}`;
}

// Troca o authorization code pelo token. Devolve { access_token, refresh_token, scope, expiry }.
export async function providerExchange(name, code, opts = {}) {
  const p = PROVIDERS[name];
  if (p.exchange) return p.exchange(p, code, opts);
  const body = new URLSearchParams({
    code,
    client_id: p.clientId(),
    client_secret: p.clientSecret(),
    redirect_uri: p.redirectUri(),
    grant_type: 'authorization_code',
  });
  if (p.pkce && opts.codeVerifier) body.set('code_verifier', opts.codeVerifier);
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`${name} token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return p.parseToken(await r.json());
}

// Renova o access_token (só providers com refresh, tipo Microsoft). Devolve o
// mesmo shape do parseToken, ou null se o provider não suporta refresh.
export async function providerRefresh(name, refreshToken) {
  const p = PROVIDERS[name];
  return p?.refresh ? p.refresh(p, refreshToken) : null;
}

// Home pra onde voltar depois do callback (derivada da própria redirect URI).
export function providerHome(name) {
  const uri = PROVIDERS[name]?.redirectUri() || '/';
  return uri.replace(/api\/connect\/\w+\/callback$/, '');
}
