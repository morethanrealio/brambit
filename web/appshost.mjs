// ── Apps host control-plane client (per-user mini-PaaS) ──
// The apps host only has 443 (Caddy/router) and 22 (SSH) open. There is no
// own daemon port (unlike the sandbox). So the control-plane is OVER SSH: we
// open a connection, send ONE JSON command on the host's `ctl.py` stdin and
// read ONE JSON line on stdout. `ctl.py` runs `docker run` with the limits,
// writes the router's registry and keeps each user's "home".
//
// Only turns on if APPS_HOST_SSH + APPS_HOST_KEY are in the environment
// (hostingEnabled()).
//   APPS_HOST_SSH = ec2-user@10.0.0.30      (user@private-IP of the apps host)
//   APPS_HOST_KEY = /home/ubuntu/.ssh/brambs-apps   (channel's private key)

import { spawn } from 'node:child_process';
import { hostDaMarca } from './marca.mjs';

const SSH_TARGET = process.env.APPS_HOST_SSH || '';
const SSH_KEY    = process.env.APPS_HOST_KEY || '';
const CTL_PATH   = process.env.APPS_CTL_PATH || '/opt/brambs-ctl/ctl.py';

export function hostingEnabled() { return !!(SSH_TARGET && SSH_KEY); }

// Apps domain: each owner gets <label>.<domínio>, and each system lives under
// their /<sistema>/. APPS_DOMAIN in the environment; without it, the brand
// site's host (the apps host's wildcard DNS sits under the site's domain).
// Read at the time of use, like the brand.
export const dominioDosApps = () => process.env.APPS_DOMAIN || hostDaMarca();
export const urlDoApp = (label, system = '') => `https://${label}.${dominioDosApps()}/${system ? system + '/' : ''}`;

// Sends the command over ssh's stdin. The 'error' listener is mandatory: when
// the other side closes the pipe (ssh died, ctl.py crashed, timeout killed
// the process), the stream emits EPIPE ASYNCHRONOUSLY, so the try/catch
// around the write catches nothing. A stream with no 'error' listener throws
// the exception outside any try/catch and used to bring down the whole
// process (finding #23) because of one failed hosting call. Swallowing the
// EPIPE is deliberate: the call's real outcome comes from the process's
// 'close' event, which returns {ok:false,error}. Same pattern media.mjs
// already uses with ffmpeg.
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

// Runs a ctl.py verb on the host. cmd = object with {verb, ...}. Returns the
// JSON response object ({ok:true,...} | {ok:false,error}). Never throws:
// transport errors turn into {ok:false,error}.
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
    // The domain goes along on every call: ctl.py builds the URL and the Host with it.
    const falhaStdin = escreverNoStdin(p.stdin, JSON.stringify({ dominio: dominioDosApps(), ...cmd }));
    if (falhaStdin) {
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch { /* */ }
      resolve({ ok: false, error: `stdin falhou: ${falhaStdin.message}` });
    }
  });
}
