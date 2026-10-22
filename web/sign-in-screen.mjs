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
//  privacyUrl / termsUrl: where the installation's privacy policy and terms of
//   use are. BRAMBIT_PRIVACY_URL and BRAMBIT_TERMS_URL win (an https address
//   or a path of this site); else the /privacidade and /termos pages, when a
//   brand or plugin serves them; else null, and the screens hide what would
//   link to them instead of leading to a page that doesn't exist. Read on
//   every call, so the admin settings screen changes them without a restart.
//
// deps: permissoes (the permissions port) and coreSignup = whether the core's
// default answers that port (no plugin does).
import { linkDaPagina } from './brand.mjs';

const usable = (v) => /^https:\/\/[^\s"'<>]+$/i.test(v) || /^\/(?!\/)[^\s"'<>]*$/.test(v);
const warned = new Set();

// The setting's value if usable, else the site's own page if it exists, else null.
export function legalUrl(setting, raw, page, pageExists = (p) => !!linkDaPagina(p)) {
  const value = String(raw ?? '').trim();
  if (value && usable(value)) return value;
  if (value && !warned.has(setting + value)) {
    warned.add(setting + value);
    console.warn(`[sign-in] ${setting} ignored: use an https:// address or a path of this site`);
  }
  return pageExists(page) ? `/${page}` : null;
}

export function createSignInScreen({ permissoes, coreSignup }) {
  return async function signInScreen() {
    let signupClosed = false;
    if (coreSignup) {
      try { signupClosed = !!(await permissoes.filaDeEspera()); }
      catch { /* the port's rule: an error here means open */ }
    }
    return {
      signupClosed,
      privacyUrl: legalUrl('BRAMBIT_PRIVACY_URL', process.env.BRAMBIT_PRIVACY_URL, 'privacidade'),
      termsUrl: legalUrl('BRAMBIT_TERMS_URL', process.env.BRAMBIT_TERMS_URL, 'termos'),
    };
  };
}
