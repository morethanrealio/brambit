// Plugin "installation": the part of Brambit on your own computer that only
// makes sense when it was started by installer/brambit.mjs (the launcher). It
// adds to the app's Settings, for the owner only, the "This computer" section:
// what is running (version, address, data folder, AI) and the "Change the AI"
// and "Turn Brambit off" buttons. The launcher, which holds the database and
// the server, does both: the server only asks, over the message channel (IPC)
// the launcher opened when starting it. Without that channel (a server started
// some other way) the routes do not even exist.
//
// For everyone else (another signed-in person, nobody signed in) the routes do
// not exist either: SEGUE lets the server answer 404 as for any unknown path.
// The POSTs go through the server's Origin check (CSRF).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGUE } from '../../web/rotas.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// info = what the launcher tells (BRAMBIT_INSTALLATION); send = channel to it.
export function createInstallationPlugin({ info = readInfo(), sendToLauncher = process.send?.bind(process) } = {}) {
  return {
    nome: 'installation',
    app: [path.join(here, 'app')],
    siteTextos: [path.join(here, 'site-textos')],
    ligar({ rotas, send }) {
      if (!sendToLauncher || !info) return;
      const noCache = { 'cache-control': 'no-store' };
      const isOwner = async (ctx) => {
        const admin = String(process.env.ADMIN_EMAIL || '').toLowerCase();
        const u = admin ? await ctx.currentUser() : null;
        return Boolean(u && String(u.email || '').toLowerCase() === admin);
      };
      // Answers first and only then tells the launcher, which will stop this server.
      const afterResponse = (res, msg) => res.once('finish', () => sendToLauncher(msg));

      rotas.registrar('GET', '/api/installation', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        send(res, 200, info, noCache);
      });
      rotas.registrar('POST', '/api/installation/shutdown', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        afterResponse(res, { action: 'shutdown' });
        send(res, 200, { ok: true }, noCache);
      });
      // Opens the AI setup page in place of the app, with a one-time code only
      // this response carries (the browser puts it after the #).
      rotas.registrar('POST', '/api/installation/change-ai', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        const code = randomBytes(18).toString('base64url');
        afterResponse(res, { action: 'change-ai', code });
        send(res, 200, { code }, noCache);
      });
    },
  };
}

function readInfo() {
  try { return JSON.parse(process.env.BRAMBIT_INSTALLATION || 'null'); } catch { return null; }
}
