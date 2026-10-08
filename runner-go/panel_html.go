package main

// Local panel page (served on 127.0.0.1 by the app itself). Self-contained,
// no external resource. On serve, __K__ becomes the session nonce and __NOME__,
// __PRODUTO__ and __SITE__ come from the brand (marca.go).
const panelHTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>__NOME__</title>
<style>
  :root{ --bg:#0f1115; --card:#171a21; --line:#262b36; --line2:#20242e; --tx:#e8eaee; --mut:#9aa3b2; --acc:#f2c14e; --ok:#3ecf8e; --bad:#ef6b6b; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--tx); font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .wrap{ max-width:640px; margin:0 auto; padding:40px 20px 60px; }
  .head{ display:flex; align-items:center; gap:14px; margin:0 0 28px; }
  .head svg{ width:44px; height:44px; color:var(--acc); flex:none; }
  .head h1{ font-size:22px; margin:0; font-weight:650; }
  .head p{ margin:2px 0 0; color:var(--mut); font-size:13.5px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; margin:0 0 18px; }
  .card h2{ font-size:16px; margin:0 0 12px; font-weight:600; }
  label{ display:block; color:var(--mut); font-size:13px; margin:0 0 6px; }
  input[type=text]{ width:100%; padding:12px 13px; border-radius:10px; border:1px solid var(--line); background:var(--line2); color:var(--tx); font-size:14px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  input[type=text]:focus{ outline:none; border-color:var(--acc); }
  .btn{ display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:11px 18px; border-radius:10px; border:1px solid var(--acc); background:var(--acc); color:#20242e; font-weight:600; font-size:14px; cursor:pointer; }
  .btn:disabled{ opacity:.55; cursor:default; }
  .btn.ghost{ background:transparent; color:var(--mut); border-color:var(--line); }
  .row{ display:flex; gap:10px; align-items:center; margin-top:12px; }
  .pill{ display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px; font-size:13px; font-weight:600; }
  .pill .dot{ width:9px; height:9px; border-radius:50%; }
  .pill.on{ background:rgba(62,207,142,.12); color:var(--ok); } .pill.on .dot{ background:var(--ok); }
  .pill.off{ background:rgba(239,107,107,.12); color:var(--bad); } .pill.off .dot{ background:var(--bad); }
  .pill.wait{ background:rgba(242,193,78,.12); color:var(--acc); } .pill.wait .dot{ background:var(--acc); }
  .kv{ display:grid; grid-template-columns:120px 1fr; gap:6px 14px; margin:14px 0 0; font-size:13.5px; }
  .kv .k{ color:var(--mut); } .kv .v{ color:var(--tx); word-break:break-word; }
  .log{ margin-top:14px; background:#0b0d11; border:1px solid var(--line); border-radius:10px; padding:12px 13px; font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace; color:#aeb6c2; max-height:180px; overflow:auto; white-space:pre-wrap; }
  .muted{ color:var(--mut); font-size:13px; }
  a{ color:var(--acc); }
  .hide{ display:none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <svg viewBox="0 0 428 416" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path transform="translate(237.96484375,21.59765625)" fill="currentColor" d="M0 0 C7.81 7.229 12.044 17.158 16.16 26.777 C16.628 27.853 17.095 28.929 17.576 30.037 C20.073 35.796 22.534 41.569 24.992 47.344 C30.054 59.232 35.168 71.086 40.535 82.84 C41.027 83.93 41.52 85.019 42.027 86.142 C45.534 93.751 48.109 99.044 56.013 102.445 C61.931 104.32 68.129 104.759 74.283 105.37 C76.869 105.626 79.453 105.901 82.036 106.181 C86.605 106.671 91.176 107.146 95.747 107.616 C103.033 108.364 110.316 109.126 117.598 109.909 C120.112 110.175 122.627 110.428 125.143 110.68 C132.979 111.494 140.652 112.581 148.334 114.35 C149.022 114.506 149.709 114.662 150.417 114.824 C160.807 117.37 167.597 122.829 173.441 131.656 C178.659 140.646 179.592 150.221 177.379 160.43 C172.556 175.251 159.32 185.955 147.52 195.355 C145.382 197.117 143.454 198.91 141.535 200.902 C138.853 203.686 136.005 206.068 132.973 208.465 C127.622 212.761 122.839 217.48 118.035 222.374 C114.964 225.495 111.88 228.507 108.535 231.34 C102.753 236.266 97.621 241.289 96.719 249.157 C96.648 258.403 98.349 266.887 100.465 275.816 C100.82 277.363 101.174 278.91 101.527 280.457 C102.451 284.497 103.391 288.532 104.336 292.567 C105.477 297.455 106.601 302.348 107.726 307.241 C108.601 311.05 109.48 314.858 110.369 318.664 C118.364 353.008 118.364 353.008 109.223 369.715 C103.762 376.423 96.681 381.746 88.035 383.402 C64.581 385.075 46.214 371.115 27.035 359.402 C22.286 356.504 17.537 353.608 12.785 350.715 C12.484 350.532 12.484 350.532 10.962 349.605 C3.851 345.279 -3.274 340.987 -10.527 336.902 C-11.157 336.547 -11.787 336.192 -12.437 335.825 C-17.506 333.012 -21.126 331.931 -26.965 332.402 C-40.593 336.561 -53.523 346.303 -65.59 353.652 C-66.192 354.019 -66.793 354.385 -67.413 354.763 C-68.63 355.504 -69.847 356.245 -71.064 356.986 C-117.652 385.359 -117.652 385.359 -134.965 383.402 C-145.324 380.705 -153.439 374.52 -158.965 365.402 C-163.254 357.093 -163.473 347.795 -162.09 338.715 C-161.963 337.853 -161.837 336.991 -161.706 336.104 C-159.475 322.159 -155.898 308.437 -152.668 294.698 C-150.84 286.906 -149.078 279.103 -147.402 271.277 C-147.151 270.155 -146.9 269.032 -146.641 267.875 C-144.87 259.465 -143.263 250.168 -146.215 241.902 C-146.792 241.077 -147.37 240.252 -147.965 239.402 C-148.522 238.598 -149.079 237.794 -149.652 236.965 C-151.559 234.852 -153.427 233.086 -155.578 231.242 C-160.733 226.767 -165.663 222.066 -170.609 217.363 C-174.71 213.48 -178.872 209.693 -183.139 205.992 C-185.617 203.835 -188.042 201.621 -190.465 199.402 C-195.647 194.678 -200.873 190.01 -206.234 185.488 C-206.97 184.862 -207.706 184.235 -208.465 183.59 C-209.135 183.027 -209.805 182.463 -210.496 181.883 C-211.965 180.402 -211.965 180.402 -211.965 178.402 C-212.625 178.402 -213.285 178.402 -213.965 178.402 C-223.144 167.134 -227.469 157.257 -225.965 142.402 C-223.519 132.355 -217.53 124.589 -208.896 119.042 C-198.964 113.486 -187.59 112.457 -176.473 111.332 C-174.913 111.164 -173.353 110.995 -171.793 110.825 C-167.72 110.384 -163.645 109.958 -159.57 109.536 C-154.649 109.023 -149.73 108.494 -144.811 107.966 C-140.978 107.554 -137.143 107.146 -133.308 106.746 C-126.432 106.026 -119.562 105.265 -112.703 104.391 C-112.109 104.316 -112.109 104.316 -109.103 103.935 C-101.668 102.673 -97.884 99.817 -93.533 93.833 C-90.613 89.306 -88.472 84.436 -86.277 79.527 C-85.762 78.393 -85.246 77.258 -84.715 76.089 C-79.712 65 -74.995 53.791 -70.294 42.572 C-52.41 -0.076 -52.41 -0.076 -37.113 -6.848 C-23.25 -11.687 -11.3 -9.188 0 0 Z"/>
    </svg>
    <div>
      <h1>__NOME__</h1>
      <p>Deixa seu assistente trabalhar nesta máquina.</p>
    </div>
  </div>

  <div class="card" id="setup">
    <h2>Conectar</h2>
    <p class="muted" style="margin:0 0 14px;">Cole aqui o código que aparece na página do __PRODUTO__ (em <b>__SITE__/runner</b>, botão "gerar código"). É só uma vez.</p>
    <label for="tok">Código de conexão</label>
    <input type="text" id="tok" placeholder="cole o código aqui" autocomplete="off" spellcheck="false"/>
    <div class="row"><button class="btn" id="save">Conectar</button><span class="muted" id="msg"></span></div>
  </div>

  <div class="card hide" id="cerca">
    <h2>Esta máquina não tem cerca de escrita</h2>
    <div id="cercaRestrito">
      <p class="muted" style="margin:0 0 12px;">Neste sistema não dá pra limitar em quais pastas o assistente grava. Por segurança, no modo restrito o runner <b>recusa todos os comandos</b>.</p>
      <p class="muted" style="margin:0 0 12px;">Se você confia no assistente nesta máquina, pode liberar acesso total: ele vai poder ler e gravar em qualquer pasta que o seu usuário alcança.</p>
      <p class="muted hide" id="cercaLinux" style="margin:0 0 12px;">Alternativa no Linux: instale o bubblewrap (pacote <b>bwrap</b>) e reabra o runner. Aí a cerca liga e o modo restrito volta a funcionar.</p>
      <div class="row"><button class="btn" id="liberar">Liberar acesso total nesta máquina</button><span class="muted" id="cercaMsg"></span></div>
    </div>
    <div id="cercaTotal" class="hide">
      <p class="muted" style="margin:0 0 12px;">Acesso total liberado: o assistente lê e grava em qualquer pasta que o seu usuário alcança.</p>
      <div class="row"><button class="btn ghost" id="bloquear">Voltar a bloquear</button><span class="muted" id="cercaMsg2"></span></div>
    </div>
    <p class="muted hide" id="cercaFixo" style="margin:0;">O modo está fixado pela variável BRAMBS_RUNNER_MODE; pra trocar aqui, tire essa variável.</p>
  </div>

  <div class="card">
    <h2 style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      Status
      <span class="pill wait" id="pill"><span class="dot"></span><span id="pillt">verificando…</span></span>
    </h2>
    <div class="kv">
      <div class="k">Máquina</div><div class="v" id="host">—</div>
      <div class="k">Sistema</div><div class="v" id="osv">—</div>
      <div class="k">Escrita</div><div class="v" id="mode">—</div>
      <div class="k">Última resposta</div><div class="v" id="lastok">—</div>
    </div>
    <div class="log" id="log">—</div>
    <div class="row"><button class="btn ghost" id="quit">Encerrar o runner</button></div>
  </div>

  <p class="muted" style="text-align:center;">O app fica rodando quietinho. Pode fechar esta aba, ele continua conectado. Pra parar de vez, clique em "Encerrar o runner".</p>
</div>

<script>
const K = "__K__";
const $ = (id) => document.getElementById(id);
function q(p){ return p + (p.includes("?") ? "&" : "?") + "k=" + K; }

async function refresh(){
  try {
    const r = await fetch(q("/status"));
    const s = await r.json();
    $("host").textContent = s.hostname || "—";
    $("osv").textContent = (s.os||"?") + " / " + (s.arch||"?") + " · v" + (s.version||"?");
    let m = s.mode === "read-only" ? "só leitura (não escreve nada)"
          : s.mode === "full-access" ? "acesso total (sem cerca)"
          : ("só nas pastas: " + ((s.writeDirs||[]).join(", ") || "—"));
    if (s.confined === false && s.mode !== "full-access") m = "bloqueado: sem cerca neste sistema, comandos recusados";
    $("mode").textContent = m;
    const semCerca = s.canConfine === false;
    $("cerca").classList.toggle("hide", !semCerca);
    if (semCerca){
      const total = s.mode === "full-access";
      $("cercaRestrito").classList.toggle("hide", total || s.modeLocked);
      $("cercaTotal").classList.toggle("hide", !total || s.modeLocked);
      $("cercaFixo").classList.toggle("hide", !s.modeLocked);
      $("cercaLinux").classList.toggle("hide", s.os !== "linux");
    }
    $("lastok").textContent = s.lastOK || "—";
    $("log").textContent = (s.lines||[]).join("\n") || "—";
    const pill = $("pill"), pt = $("pillt");
    if (!s.tokenPresent){ pill.className="pill wait"; pt.textContent="aguardando código"; $("setup").classList.remove("hide"); }
    else if (s.connected){ pill.className="pill on"; pt.textContent="conectado"; $("setup").classList.add("hide"); }
    else { pill.className="pill wait"; pt.textContent="conectando…"; $("setup").classList.add("hide"); }
  } catch(e){
    $("pill").className="pill off"; $("pillt").textContent="painel offline";
  }
}
$("save").addEventListener("click", async () => {
  const t = $("tok").value.trim();
  if (!t){ $("msg").textContent="cole o código primeiro"; return; }
  $("save").disabled=true; $("msg").textContent="salvando…";
  try {
    const r = await fetch(q("/token"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({token:t}) });
    const j = await r.json();
    if (j.ok){ $("msg").textContent="pronto, conectando…"; $("tok").value=""; }
    else { $("msg").textContent = j.error || "falhou"; }
  } catch(e){ $("msg").textContent="erro ao salvar"; }
  $("save").disabled=false;
  refresh();
});
async function setMode(mode, btn, msg){
  btn.disabled=true; msg.textContent="salvando…";
  try {
    const r = await fetch(q("/mode"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({mode}) });
    const j = await r.json();
    msg.textContent = j.ok ? "" : (j.error || "falhou");
  } catch(e){ msg.textContent="erro ao salvar"; }
  btn.disabled=false;
  refresh();
}
$("liberar").addEventListener("click", () => {
  if (!confirm("Liberar acesso total nesta máquina?\n\nO assistente vai poder ler, gravar e apagar arquivos em qualquer pasta que o seu usuário alcança, sem cerca. Você pode voltar a bloquear aqui a qualquer momento.")) return;
  setMode("full-access", $("liberar"), $("cercaMsg"));
});
$("bloquear").addEventListener("click", () => setMode("workspace-write", $("bloquear"), $("cercaMsg2")));
$("quit").addEventListener("click", async () => {
  if (!confirm("Encerrar o __NOME__ nesta máquina?")) return;
  try { await fetch(q("/quit"), { method:"POST" }); } catch(e){}
  $("pill").className="pill off"; $("pillt").textContent="encerrado";
});
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`
