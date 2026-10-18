// Revoking a connector's access at the provider (GitHub, Slack, Notion, Canva),
// when the person disconnects it or deletes the account. Deleting only our row
// leaves the app authorized on the provider's side, and a token left in an old
// backup still works. Revoking a token cuts off whoever holds it, so nothing is
// revoked while another user of this install holds the very same token; the
// provider hook adds its own rule when its revocation reaches further (see
// providers.mjs). A failure never blocks what the person asked for.
import { decMaybe } from './vault.mjs';
import { providerRevoke } from './providers.mjs';

const S = 'mtr_harness';

export function createOAuthRevocation(pool, { revoke = providerRevoke } = {}) {
  async function revokeOAuthGrant(userId, provider) {
    try {
      const { rows } = await pool.query(
        `SELECT user_id, access_token, refresh_token, meta FROM ${S}.oauth_tokens
          WHERE provider=$1 AND access_token IS NOT NULL`, [provider]);
      const all = rows.map((r) => ({ ...r, access_token: decMaybe(r.access_token), refresh_token: decMaybe(r.refresh_token) }));
      const row = all.find((r) => String(r.user_id) === String(userId));
      if (!row) return;
      const others = all.filter((r) => r !== row);
      if (others.some((o) => o.access_token === row.access_token || (row.refresh_token && o.refresh_token === row.refresh_token))) return;
      await revoke(provider, row, others);
    } catch (e) {
      console.warn(`[${provider}] revoking user ${userId}'s access failed:`, e?.message ?? e);
    }
  }

  async function revokeOAuthGrants(userId) {
    const { rows } = await pool.query(
      `SELECT provider FROM ${S}.oauth_tokens WHERE user_id=$1 AND access_token IS NOT NULL`, [userId]);
    for (const r of rows) await revokeOAuthGrant(userId, r.provider);
  }

  return { revokeOAuthGrant, revokeOAuthGrants };
}
