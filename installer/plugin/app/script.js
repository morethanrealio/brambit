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
  // Shared with others at home (brambit share): the address they open.
  E('instShared').textContent = info.shared || '';
  E('instSharedRow').classList.toggle('hidden', !info.shared);
  const ai = info.ai || {};
  const brand = { together: 'Together', openai: 'OpenAI', gemini: 'Google Gemini', deepinfra: 'DeepInfra', deepseek: 'DeepSeek' }[ai.provider];
  E('instAi').textContent = [brand, ai.model].filter(Boolean).join(' · ');
  E('instAudio').textContent = { openai: 'OpenAI', gemini: 'Google Gemini' }[info.audio] || 'Desligadas';
  E('instDataDir').textContent = info.dataDir || '';
  E('instVersion').textContent = info.version || '';
  box.classList.remove('hidden');
}
function installationStatus(msg) {
  const el = E('instStatus');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}
// Both are pages of the app: the AI changes while the assistant keeps working.
E('instChangeAi').onclick = () => { location.href = '/installation/ai'; };
E('instSystemSettings').onclick = () => { location.href = '/admin/settings'; };
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
