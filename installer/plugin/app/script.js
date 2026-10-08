// This computer (installation plugin). The section only shows if /api/installation
// answers, that is, for the owner and with Brambit started by the launcher.
async function installationLoad() {
  const box = E('installationBox');
  if (!box) return;
  let r;
  try { r = await fetch('/api/installation', { credentials: 'same-origin', cache: 'no-store' }); } catch { return; }
  if (!r.ok) return box.classList.add('hidden');
  const info = await r.json().catch(() => null);
  if (!info) return;
  E('instAddress').textContent = info.url || '';
  const ai = info.ai || {};
  const brand = { together: 'Together', openai: 'OpenAI', gemini: 'Google Gemini' }[ai.provider];
  E('instAi').textContent = [brand, ai.model].filter(Boolean).join(' · ');
  E('instDataDir').textContent = info.dataDir || '';
  E('instVersion').textContent = info.version || '';
  box.classList.remove('hidden');
}
function installationStatus(msg) {
  const el = E('instStatus');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}
// The launcher stops the server and starts the setup page on the same address;
// it answers with the x-brambit-setup header.
async function installationWaitForSetup() {
  for (let i = 0; i < 120; i++) {
    await new Promise((ok) => setTimeout(ok, 500));
    try {
      const r = await fetch('/', { cache: 'no-store' });
      if (r.headers.get('x-brambit-setup') === '1') return true;
    } catch { /* switching from one to the other */ }
  }
  return false;
}
E('instChangeAi').onclick = async () => {
  const ok = await confirmModal({ title: 'Trocar a IA ou o modelo', body: 'O Brambit vai parar um instante pra você escolher a IA e o modelo. A chave salva pode continuar a mesma. As conversas e os dados continuam aqui.', okLabel: 'Continuar' });
  if (!ok) return;
  installationStatus('Abrindo a configuração da IA...');
  const j = await api('/api/installation/change-ai', {});
  if (!j || !j.code) return installationStatus('Não deu certo. Tente de novo.');
  if (!(await installationWaitForSetup())) return installationStatus('A configuração não abriu. Veja a mensagem na janela do Brambit.');
  location.href = '/?ai#code=' + encodeURIComponent(j.code);
};
E('instShutdown').onclick = async () => {
  const ok = await confirmModal({ title: 'Desligar o Brambit', body: 'O assistente para de responder, inclusive no Telegram e no WhatsApp, até você ligar de novo.', okLabel: 'Desligar' });
  if (!ok) return;
  const j = await api('/api/installation/shutdown', {});
  if (!j || !j.ok) return installationStatus('Não deu certo. Tente de novo.');
  const notice = document.createElement('div');
  notice.style.cssText = 'max-width:460px;margin:80px auto;padding:0 20px;font:16px/1.5 system-ui,sans-serif;';
  const t = document.createElement('h2');
  t.textContent = 'O Brambit foi desligado';
  const p = document.createElement('p');
  p.textContent = 'Pra ligar de novo, abra o Brambit pelo atalho ou rode o comando brambit.';
  notice.append(t, p);
  document.body.replaceChildren(notice);
};
ganchosDoApp.aoTrocarAba.push((tab) => { if (tab === 'config') installationLoad(); });
