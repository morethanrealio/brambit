// Account deletion: revokes the links the person gave to outside providers
// BEFORE closing the account, because closing deletes the tokens the revocation
// needs. A failure here never blocks the deletion, which is what the person asked
// for.
//
// Apple, guideline 5.1.1(v): deleting only on our side leaves the app listed
// forever in Settings > Apple ID > Sign in with Apple. Without the .p8 key
// configured, log and go on (Apple login works without it; revocation doesn't).
// Google: every connected Google account, with the rule in
// google-account-removal.mjs (kept while another user shares that Google account).
import { getAppleRefreshToken, revokeGoogleAccounts } from './db.mjs';
import { appleRevokeReady, appleRevoke } from './apple-auth.mjs';

export async function revokeProviderGrants(userId) {
  const appleToken = await getAppleRefreshToken(userId).catch(() => null);
  if (appleToken) {
    if (!appleRevokeReady()) {
      console.warn(`[account-delete] user ${userId} has an Apple ID but APPLE_PRIVATE_KEY is not configured: revocation not performed`);
    } else {
      try { await appleRevoke(appleToken); }
      catch (e) { console.error(`[account-delete] Apple revocation user ${userId}:`, e?.message ?? e); }
    }
  }
  try { await revokeGoogleAccounts(userId); }
  catch (e) { console.error(`[account-delete] Google revocation user ${userId}:`, e?.message ?? e); }
}
