// Where the person CAME FROM (FIRST-TOUCH attribution).
//
// Google Ads conversion tells "how many sign-ups the ad brought"; this tells
// WHO (becomes users.attribution). These are different, independent things: the
// conversion is gtag's, this one is ours.
//
// Why a separate file (2026-09-08): until 2026-09-05 route `/` was index.html, which
// had this capture inline, so the ad click landed exactly on the page
// that captured it. In commit 10d538f the public home became its OWN page
// (home.html), which had NO capture at all and whose buttons point to /login
// WITHOUT carrying the query string. Result: since 2026-09-05 every ad click lost
// the gclid, and users.attribution stayed empty (the last sign-up with a gclid is from
// 2026-09-05 00:07, minutes before the deploy). Since any public page can be the
// landing page of an ad, the capture lives here and is included on all of them, instead
// of being copy-pasted into each one (copy-paste = one of them falls behind on the next
// redesign, which is exactly what happened).
//
// Stays in localStorage until the account exists, because sign-up can happen well
// after the click (the person browses the site, or comes back the next day, and
// Google's consent flow changes the URL in between). Whoever never signs up is never
// sent to the server: the send is index.html's marcarOrigem(), at the moment
// the account is created.
//
// Used as `<script src="/atribuicao.js"></script>`: same-origin script,
// allowed by the CSP's `script-src 'self'`, so it does NOT need a nonce.
(function () {
  var KEY = 'brambs_attr';
  var CAMPOS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  // LOGIN hosts: these are OUR OWN "sign in with Google/Microsoft" flow,
  // not a source. Whoever comes in through there returns from consent with
  // document.referrer = accounts.google.com; on a DIRECT visit (no utm and no
  // real referrer) first-touch wasn't recording anything, so this was the first
  // stamp left standing and a direct sign-up became "came from accounts.google.com"
  // (4 of the 6 users with attribution ended up like this). Better to have no stamp
  // than a wrong stamp: this data is used to decide ad spend.
  var REF_LOGIN = /(^|\.)(accounts\.google\.com|accounts\.youtube\.com|account\.live\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com|appleid\.apple\.com)$/;

  function capturar() {
    try {
      if (localStorage.getItem(KEY)) return; // primeiro toque vence
      var q = new URLSearchParams(location.search);
      var attr = {};
      for (var i = 0; i < CAMPOS.length; i++) {
        var v = q.get(CAMPOS[i]);
        if (v) attr[CAMPOS[i]] = v.slice(0, 200);
      }
      if (!Object.keys(attr).length) {
        // Without a campaign parameter: the external referrer still says where it came from
        // (organic search, a referral on a site). Our own referrer doesn't count.
        var ref = document.referrer || '';
        if (!ref || ref.indexOf(location.origin) === 0) return;
        var host = '';
        try { host = new URL(ref).hostname.toLowerCase(); } catch (e) { return; }
        if (REF_LOGIN.test(host)) return;
        attr.referrer = ref.slice(0, 200);
      }
      attr.landing = location.pathname.slice(0, 120);
      localStorage.setItem(KEY, JSON.stringify(attr));
    } catch (e) { /* measurement must never break the page */ }
  }

  capturar();
  window.Atribuicao = { KEY: KEY, capturar: capturar };
})();
