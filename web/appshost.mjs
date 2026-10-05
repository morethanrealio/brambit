// ── Cliente do control-plane do host de apps (mini-PaaS por usuário) ──
// O host de apps só tem 443 (Caddy/roteador) e 22 (SSH) abertas. Não há porta
// de daemon própria (ao contrário do sandbox). Então o control-plane é POR SSH:
// abrimos uma conexão, mandamos UM comando JSON no stdin do `ctl.py` no host e
// lemos UMA linha JSON no stdout. O `ctl.py` roda `docker run` com os limites,
// grava o registry do roteador e mantém a "home" de cada usuário.
//
// Liga só se APPS_HOST_SSH + APPS_HOST_KEY estiverem no ambiente (hostingEnabled()).
//   APPS_HOST_SSH = ec2-user@10.0.0.30      (usuário@IP-privado do host de apps)
//   APPS_HOST_KEY = /home/ubuntu/.ssh/brambs-apps   (chave privada do canal)

import { spawn } from 'node:child_process';
import { hostDaMarca } from './marca.mjs';

const SSH_TARGET = process.env.APPS_HOST_SSH || '';
const SSH_KEY    = process.env.APPS_HOST_KEY || '';
const CTL_PATH   = process.env.APPS_CTL_PATH || '/opt/brambs-ctl/ctl.py';

export function hostingEnabled() { return !!(SSH_TARGET && SSH_KEY); }

// Domínio dos apps: cada dono ganha <label>.<domínio>, e cada sistema mora em
// /<sistema>/ dele. APPS_DOMAIN no ambiente; sem ele, o host do site da marca
// (o DNS curinga do host de apps fica embaixo do domínio do site). Lido na hora
// do uso, como a marca.
export const dominioDosApps = () => process.env.APPS_DOMAIN || hostDaMarca();
export const urlDoApp = (label, system = '') => `https://${label}.${dominioDosApps()}/${system ? system + '/' : ''}`;

// Manda o comando pelo stdin do ssh. O listener de 'error' é obrigatório: quando
// o outro lado fecha o cano (ssh caiu, ctl.py morreu, timeout matou o processo),
// o stream emite EPIPE de forma ASSÍNCRONA, então o try/catch em volta do write
// não pega nada. Stream sem listener de 'error' joga a exceção fora de qualquer
// try/catch e derrubava o processo inteiro (achado #23) por causa de uma chamada
// de hosting que falhou. Engolir o EPIPE é de propósito: o desfecho real da
// chamada vem do evento 'close' do processo, que devolve {ok:false,error}.
// Mesmo padrão que media.mjs já usa com o ffmpeg.
export function escreverNoStdin(stdin, texto) {
  stdin.on('error', () => {});
  try {
    stdin.write(texto);
    stdin.end();
    return null;
  } catch (e) {
    return e;
  }
}

// Roda um verbo do ctl.py no host. cmd = objeto com {verb, ...}. Devolve o
// objeto JSON de resposta ({ok:true,...} | {ok:false,error}). Nunca lança:
// erros de transporte viram {ok:false,error}.
export function ctl(cmd, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    if (!hostingEnabled()) return resolve({ ok: false, error: 'hosting desligado (sem APPS_HOST_SSH/KEY)' });
    const args = [
      '-i', SSH_KEY,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=12',
      '-o', 'BatchMode=yes',
      SSH_TARGET,
      `sudo python3 ${CTL_PATH}`,
    ];
    const p = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `ssh falhou: ${e.message}` }); });
    p.on('close', () => {
      clearTimeout(timer);
      const line = (out || '').trim().split('\n').filter(Boolean).pop() || '';
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: (err || out || 'sem resposta do host').trim().slice(0, 300) });
      }
    });
    // O domínio vai junto em toda chamada: o ctl.py monta a URL e o Host com ele.
    const falhaStdin = escreverNoStdin(p.stdin, JSON.stringify({ dominio: dominioDosApps(), ...cmd }));
    if (falhaStdin) {
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch { /* */ }
      resolve({ ok: false, error: `stdin falhou: ${falhaStdin.message}` });
    }
  });
}
