import { microsoftOnboardingScope } from './microsoft-scopes.mjs';
import crypto from 'node:crypto';

// ── Generic OAuth connectors (GitHub, Slack, and whatever comes next) ──
// Same pattern as Google (auth.mjs), but in a registry: to add a new service
// it's just one entry here plus its tools in connectors-ext.mjs. The token is
// stored by (user, provider) in mtr_harness.oauth_tokens.
//
// GitHub and Slack return tokens that do NOT expire (no refresh), so the flow is
// simple: authorize -> exchange the code -> store the access_token.

const PROVIDERS = {
  github: {
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // repo (issues/PRs/code, public and private) + identity.
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
    // USER token (the assistant acts as the person): goes in user_scope.
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
    // Nuvemshop/Tiendanube's OAuth deviates from the generic one: the app_id goes in the PATH of the
    // authorization URL (scopes and redirect are defined in the app's panel), and the
    // code exchange is in JSON, without redirect_uri. Hence it uses the buildAuthUrl/exchange hooks.
    clientId: () => process.env.NUVEMSHOP_CLIENT_ID, // = App ID
    clientSecret: () => process.env.NUVEMSHOP_CLIENT_SECRET,
    redirectUri: () => process.env.NUVEMSHOP_REDIRECT_URI, // registered in the panel; used only to derive the home
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
      // user_id = store id (store_id), stored in the meta to build the API base.
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
    // Hotmail/Outlook.com = Microsoft account -> Microsoft Graph via OAuth (Entra ID).
    // The /common/ tenant accepts both personal (Hotmail/Outlook) AND corporate accounts.
    // Unlike GitHub/Slack, the access_token EXPIRES (~1h): needs a refresh_token
    // (offline_access scope). The refresh is handled in validProviderToken (server.mjs)
    // via providerRefresh() below.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // offline_access = refresh_token; User.Read = identity; Mail.Read/Send = email;
    // Calendars.ReadWrite = Outlook calendar (read/create/edit/delete event);
    // Files.ReadWrite = user's OneDrive (read, search and upload a file).
    // Files.ReadWrite is the LEAST privileged one that works: it only covers the
    // PERSON'S own drive, does NOT require admin consent and works on a personal
    // account (Hotmail/Outlook.com). The `.All` siblings (Files.Read.All/Files.ReadWrite.All)
    // reach shared files and SharePoint, but require admin and don't
    // exist on a personal account — that's why they're left out on purpose.
    // NOTE: users who connected BEFORE a line like this have no new scope
    // in their token; they need to reconnect (click to connect Outlook again) so
    // Microsoft asks for incremental consent. Without that, the tools for the
    // missing scope return 403 until reconnection (the OneDrive tools detect this
    // via the stored `scope` and already respond asking for reconnection, without calling the API).
    scope: 'openid offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.ReadWrite',
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri: () => process.env.MICROSOFT_REDIRECT_URI,
    // Microsoft requires an explicit response_type; select_account lets the user choose
    // which Microsoft account to use.
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
    // Renews the access_token using the refresh_token. Microsoft MAY return a
    // new refresh_token (rotation); parseToken preserves the old one if it comes as null and
    // saveOAuthToken does a COALESCE, so we never lose the refresh.
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
    // Notion already worked via the Vault (the user created an internal integration,
    // copied the "Internal Integration Secret" and still had to grant access page by
    // page under ••• › Connections). It still works; this here is the one-click path.
    // The gain isn't just skipping the token: on Notion's consent screen
    // the user themselves picks in the page picker what the integration sees, so
    // per-page granting goes away too.
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    // Scope doesn't go in the URL: what defines the capability is the integration's
    // configuration in the Notion panel, and the content scope is the page picker.
    scope: '',
    clientId: () => process.env.NOTION_CLIENT_ID,
    clientSecret: () => process.env.NOTION_CLIENT_SECRET,
    redirectUri: () => process.env.NOTION_REDIRECT_URI,
    // owner=user is required in the public flow.
    extraAuth: { response_type: 'code', owner: 'user' },
    parseToken: (j) => {
      if (j.error) throw new Error(`notion oauth: ${j.error_description || j.error}`);
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        scope: '',
        // Notion's token doesn't expire by default; only when the integration turns
        // expiration on in the panel does expires_in + refresh_token come. We only store
        // the validity in that case, otherwise null (= doesn't expire) and nothing to renew.
        expiry: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000) : null,
        meta: {
          workspace_id: j.workspace_id || null,
          workspace_name: j.workspace_name || null,
          bot_id: j.bot_id || null,
        },
      };
    },
    // The exchange deviates from the generic one in two points: the app credentials go in HTTP
    // Basic (not in the body) and the body is JSON.
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
    // Only comes into play if the integration has expiration turned on.
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
    // Standard OAuth 2.0 3-legged (form-urlencoded), same as GitHub/Microsoft.
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    // Default scope: identity (OpenID Connect) + posting on the member's behalf.
    //  • openid profile  → "Sign In with LinkedIn using OpenID Connect" product
    //    (userinfo returns the `sub` = member id, needed to build the author URN)
    //  • w_member_social → "Share on LinkedIn" product (post/comment)
    // If the user's app only has one of these products approved, adjust via env
    // LINKEDIN_SCOPE without touching the code (e.g.: only "w_member_social").
    scope: process.env.LINKEDIN_SCOPE || 'openid profile w_member_social',
    clientId: () => process.env.LINKEDIN_CLIENT_ID,
    clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri: () => process.env.LINKEDIN_REDIRECT_URI,
    // LinkedIn requires an explicit response_type.
    extraAuth: { response_type: 'code' },
    // LinkedIn's access_token EXPIRES (~60 days). refresh_token only exists for
    // apps approved in the refresh program; if it doesn't come, we store null and the
    // user reconnects on expiry (validProviderToken warns).
    parseToken: (j) => {
      if (j.error) throw new Error(`linkedin oauth: ${j.error_description || j.error}`);
      return {
        access_token: j.access_token,
        refresh_token: j.refresh_token || null,
        scope: j.scope || '',
        expiry: new Date(Date.now() + (Number(j.expires_in) || 5184000) * 1000),
      };
    },
    // Standard code exchange + looks up the member id (author URN) and stores it in
    // meta, in the same spirit as Nuvemshop's store_id. Tries OpenID (userinfo) and falls
    // back to the legacy /v2/me endpoint if the app uses r_liteprofile. If neither works (only
    // w_member_social granted), stores the token anyway and the post tool
    // resolves the URN on the spot (or explains which scope is missing).
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
    // Renews the access_token if the app has refresh_token enabled (rotation).
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
    // Canva comes in through its own MCP server (https://mcp.canva.com/mcp), which is the
    // authorization server itself (OAuth 2.1). Two differences compared to the
    // other connectors here:
    //  • PKCE REQUIRED (code_challenge S256 on authorize, code_verifier on
    //    exchange). This is what `pkce: true` enables in the generic path below.
    //  • the client was NOT created in a panel: it came from Dynamic Client Registration
    //    (POST https://mcp.canva.com/register, open and without auth). The client_id/
    //    secret that came out of that live in .env, like any other provider.
    // The access_token expires (~1h) and comes with a refresh_token; renewal comes
    // for free in validProviderToken (server.mjs), same as Microsoft.
    authUrl: 'https://mcp.canva.com/authorize',
    tokenUrl: 'https://mcp.canva.com/token',
    pkce: true,
    // Scopes requested (out of the 16 the server advertises). Left out on purpose:
    // brandtemplate:* and brandkit:read (require Canva Pro/Enterprise) and
    // help:answers:* (help center, not the use case). ⚠️ Expanding this
    // list forces EVERYONE who already connected to reconnect for the new
    // consent to take effect (same lesson as Calendars.ReadWrite on Outlook).
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
    // The client was registered with token_endpoint_auth_method=client_secret_basic,
    // so the credentials go in the Authorization header (not the body), and the
    // code_verifier goes along with the exchange.
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

// Call to Canva's /token with Basic auth (client_secret_basic).
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

// Finds the logged-in member's id to build the author URN (urn:li:person:<id>).
// OpenID Connect: GET /v2/userinfo -> { sub, name }. Legacy (r_liteprofile):
// GET /v2/me -> { id }. Exported because the tools also use it in the lazy fallback.
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

// Email of the connected Microsoft account (business account: domain guard).
// GET /me from Graph with the User.Read scope, which the connector ALREADY requests (no new
// scope). `mail` is the email address; a personal account (Hotmail/Outlook.com)
// sometimes comes without `mail`, in which case the login name (userPrincipalName) is the
// email itself. Returns null if there's no way to tell: the caller decides what to do.
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

// ── PKCE (RFC 7636), required by the MCP's OAuth 2.1 ──
// Turned on by the provider, with `pkce: true`. The verifier is drawn at /start and
// travels in its own cookie to /callback; only the challenge (S256) goes in the URL.
export const providerUsesPkce = (name) => !!PROVIDERS[name]?.pkce;

export const newPkceVerifier = () => crypto.randomBytes(32).toString('base64url');

export const pkceChallenge = (verifier) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

// URL we send the user to authorize. `state` protects against CSRF.
// `opts.codeVerifier` (when the provider uses PKCE) becomes the S256 code_challenge.
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

// Renews the access_token (only providers with refresh, like Microsoft). Returns the
// same shape as parseToken, or null if the provider doesn't support refresh.
export async function providerRefresh(name, refreshToken) {
  const p = PROVIDERS[name];
  return p?.refresh ? p.refresh(p, refreshToken) : null;
}

// Home to go back to after the callback (derived from the redirect URI itself).
export function providerHome(name) {
  const uri = PROVIDERS[name]?.redirectUri() || '/';
  return uri.replace(/api\/connect\/\w+\/callback$/, '');
}
