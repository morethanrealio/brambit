// Este computador (plugin instalacao). A seção só aparece se /api/instalacao
// responde, ou seja, pro dono e com o Brambit ligado pelo lançador.
async function instalacaoCarregar() {
  const box = E('instalacaoBox');
  if (!box) return;
  let r;
  try { r = await fetch('/api/instalacao', { credentials: 'same-origin', cache: 'no-store' }); } catch { return; }
  if (!r.ok) return box.classList.add('hidden');
  const info = await r.json().catch(() => null);
  if (!info) return;
  E('instEndereco').textContent = info.endereco || '';
  const ia = info.ia || {};
  const marca = { together: 'Together', openai: 'OpenAI', gemini: 'Google Gemini' }[ia.provedor];
  E('instIa').textContent = [marca, ia.modelo].filter(Boolean).join(' · ');
  E('instDados').textContent = info.dados || '';
  E('instVersao').textContent = info.versao || '';
  box.classList.remove('hidden');
}
function instalacaoEstado(msg) {
  const el = E('instEstado');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}
// O lançador para o servidor e liga a página de configuração no mesmo endereço;
// ela responde com o cabeçalho x-brambit-configuracao.
async function instalacaoEsperarConfiguracao() {
  for (let i = 0; i < 120; i++) {
    await new Promise((ok) => setTimeout(ok, 500));
    try {
      const r = await fetch('/', { cache: 'no-store' });
      if (r.headers.get('x-brambit-configuracao') === '1') return true;
    } catch { /* trocando de um pro outro */ }
  }
  return false;
}
E('instTrocarIa').onclick = async () => {
  const ok = await confirmModal({ title: 'Trocar a IA', body: 'O Brambit vai parar um instante pra você escolher a IA e colar a chave nova. As conversas e os dados continuam aqui.', okLabel: 'Continuar' });
  if (!ok) return;
  instalacaoEstado('Abrindo a configuração da IA...');
  const j = await api('/api/instalacao/trocar-ia', {});
  if (!j || !j.codigo) return instalacaoEstado('Não deu certo. Tente de novo.');
  if (!(await instalacaoEsperarConfiguracao())) return instalacaoEstado('A configuração não abriu. Veja a mensagem na janela do Brambit.');
  location.href = '/?ia#codigo=' + encodeURIComponent(j.codigo);
};
E('instDesligar').onclick = async () => {
  const ok = await confirmModal({ title: 'Desligar o Brambit', body: 'O assistente para de responder, inclusive no Telegram e no WhatsApp, até você ligar de novo.', okLabel: 'Desligar' });
  if (!ok) return;
  const j = await api('/api/instalacao/desligar', {});
  if (!j || !j.ok) return instalacaoEstado('Não deu certo. Tente de novo.');
  const aviso = document.createElement('div');
  aviso.style.cssText = 'max-width:460px;margin:80px auto;padding:0 20px;font:16px/1.5 system-ui,sans-serif;';
  const t = document.createElement('h2');
  t.textContent = 'O Brambit foi desligado';
  const p = document.createElement('p');
  p.textContent = 'Pra ligar de novo, abra o Brambit pelo atalho ou rode o comando brambit.';
  aviso.append(t, p);
  document.body.replaceChildren(aviso);
};
ganchosDoApp.aoTrocarAba.push((aba) => { if (aba === 'config') instalacaoCarregar(); });
