// Saving a data connection once the OAuth came back, shared by the site's
// callbacks (server.mjs) and the app's (mobile-connect.mjs).
//
// Business account: a member can only connect a Google or Microsoft account
// from a domain the company allows, and the token of a refused account is not
// stored. Non-members pass straight through (for Microsoft, not even the call
// to Graph that reads the account's e-mail happens).
//
// deps: empresaStore, saveGoogleAccount, saveOAuthToken, microsoftAccountEmail.
// Each function returns 'ok' or 'empresa_dominio' (refused by the domain rule).
export function createConnectSave({ empresaStore, saveGoogleAccount, saveOAuthToken, microsoftAccountEmail }) {
  return {
    // The connected Google account can be DIFFERENT from the sign-up one
    // (multi-account): the token goes to userId, whatever the e-mail.
    async google(userId, email, acct) {
      const perm = await empresaStore.conexaoPermitida(userId, email);
      if (!perm.ok) {
        console.warn(`[empresa] Google connection refused: domain not on the allow list (user ${userId})`);
        return 'empresa_dominio';
      }
      await saveGoogleAccount(userId, email, acct);
      return 'ok';
    },

    // GitHub, Slack, Microsoft... The Microsoft account e-mail comes from Graph
    // /me (scope User.Read, already requested); with no readable e-mail a member
    // is refused too, since the domain can't be proven.
    async provider(userId, prov, tok) {
      let msEmail = null;
      if (prov === 'microsoft' && await empresaStore.ehMembro(userId)) {
        msEmail = await microsoftAccountEmail(tok.access_token);
        const perm = await empresaStore.conexaoPermitida(userId, msEmail);
        if (!perm.ok) {
          console.warn(`[empresa] Microsoft connection refused: ${msEmail ? 'domain not on the allow list' : 'e-mail not identified'} (user ${userId})`);
          return 'empresa_dominio';
        }
      }
      await saveOAuthToken(userId, prov, tok);
      if (msEmail) await empresaStore.gravarEmailMicrosoft(userId, msEmail).catch((e) => console.warn('[empresa] Microsoft email not saved:', e?.message || e));
      return 'ok';
    },
  };
}
