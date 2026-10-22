// ── What the sign-in screen knows about the installation ──
// Goes out in /api/config, so /login only offers what this installation has.
//
//  signupClosed: the core's sign-up is closed (BRAMBIT_SIGNUP=closed, or the
//   public-support profile). The screen then opens on "Log in" and doesn't
//   offer "Create account": whoever isn't let in would fill in the whole form
//   only to read that sign-up is closed. /login?mode=sign-up still opens the
//   form for whoever the admin let in (ADMIN_EMAIL, BRAMBIT_SIGNUP_ALLOWED, an
//   invite). When a plugin answers the permissions port, it decides who gets
//   in (a waitlist, for one), so the screen stays as it is.
//
// deps: permissoes (the permissions port) and coreSignup = whether the core's
// default answers that port (no plugin does).
export function createSignInScreen({ permissoes, coreSignup }) {
  return async function signInScreen() {
    let signupClosed = false;
    if (coreSignup) {
      try { signupClosed = !!(await permissoes.filaDeEspera()); }
      catch { /* the port's rule: an error here means open */ }
    }
    return { signupClosed };
  };
}
