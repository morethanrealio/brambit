// De onde a pessoa VEIO (atribuição de PRIMEIRO TOQUE).
//
// A conversão do Google Ads diz "quantos cadastros o anúncio trouxe"; isto diz
// QUEM (vira users.attribution). São coisas diferentes e independentes: a
// conversão é do gtag, isto é nosso.
//
// Por que arquivo separado (08/09): até 05/09 a rota `/` era a index.html, que
// tinha esta captura inline, então o clique do anúncio caía justamente na página
// que capturava. No commit 10d538f a home pública virou página PRÓPRIA
// (home.html), que NÃO tinha captura nenhuma e cujos botões apontam pra /login
// SEM levar a query string. Resultado: desde 05/09 todo clique de anúncio perdia
// o gclid, e users.attribution ficava vazio (o último cadastro com gclid é de
// 05/09 00:07, minutos antes do deploy). Como qualquer página pública pode ser a
// landing de um anúncio, a captura mora aqui e é incluída em todas elas, em vez
// de ser copiada em cada uma (cópia colada = uma delas fica pra trás no próximo
// redesenho, que foi exatamente o que aconteceu).
//
// Fica no localStorage até a conta existir, porque o cadastro pode acontecer bem
// depois do clique (a pessoa navega pelo site, ou volta no dia seguinte, e o
// consentimento do Google troca a URL no meio). Quem nunca se cadastra nunca é
// enviado pro servidor: o envio é o marcarOrigem() da index.html, no momento em
// que a conta é criada.
//
// Serve como `<script src="/atribuicao.js"></script>`: script de mesma origem,
// permitido pelo `script-src 'self'` do CSP, então NÃO precisa de nonce.
(function () {
  var KEY = 'brambs_attr';
  var CAMPOS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  // Hosts de LOGIN: são o NOSSO próprio fluxo de "entrar com Google/Microsoft",
  // não origem. Quem entra por lá volta do consentimento com
  // document.referrer = accounts.google.com; numa visita DIRETA (sem utm e sem
  // referrer real) o primeiro toque não gravava nada, então esse era o primeiro
  // carimbo que sobrava e cadastro direto virava "veio do accounts.google.com"
  // (4 dos 6 usuários com attribution ficaram assim). Melhor não ter carimbo do
  // que ter carimbo errado: este dado é usado pra decidir gasto de anúncio.
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
        // Sem parâmetro de campanha: o referrer externo ainda diz de onde veio
        // (busca orgânica, indicação num site). Referrer nosso não conta.
        var ref = document.referrer || '';
        if (!ref || ref.indexOf(location.origin) === 0) return;
        var host = '';
        try { host = new URL(ref).hostname.toLowerCase(); } catch (e) { return; }
        if (REF_LOGIN.test(host)) return;
        attr.referrer = ref.slice(0, 200);
      }
      attr.landing = location.pathname.slice(0, 120);
      localStorage.setItem(KEY, JSON.stringify(attr));
    } catch (e) { /* medição nunca pode quebrar a página */ }
  }

  capturar();
  window.Atribuicao = { KEY: KEY, capturar: capturar };
})();
