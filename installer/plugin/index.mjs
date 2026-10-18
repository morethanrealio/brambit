// Plugin "installation": the part of Brambit on your own computer that only
// makes sense when it was started by installer/brambit.mjs (the launcher). It
// adds to the app's Settings, for the owner only, the "This computer" section:
// what is running (version, address, data folder, AI, audio) and the "Change the
// AI or the model", "System settings" and "Turn Brambit off" buttons. It also
// tells the assistant which model it runs on and where the owner changes it
// (systemNote port).
//
// Changing the AI is a page of the app (/installation/ai, the launcher's setup
// page in "change" mode): it writes the keys to the config file and the model to
// models.yaml, which the server follows live, so the assistant never stops.
// Turning Brambit off is the launcher's job, which holds the database and the
// server: the server only asks, over the message channel (IPC) the launcher
// opened when starting it. Without the launcher (BRAMBIT_INSTALLATION unset)
// the routes do not even exist.
//
// For everyone else (another signed-in person, nobody signed in) the routes do
// not exist either: SEGUE lets the server answer 404 as for any unknown path.
// The POSTs go through the server's Origin check (CSRF).
//
// Shared with others at home (info.shared, BRAMBIT_SHARED_URL in
// installer/shared.mjs), that address becomes the site's: the texts that send
// someone to the app (the invite, "connect it in the app") name the address the
// others open, not the neutral brand's localhost.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelsFilePath, loadModels } from '../../core-proto/modelos.mjs';
import { audioProvider } from '../../web/audio-provider.mjs';
import { ConfigValueError, configFilePath } from '../../web/config-file.mjs';
import { readBody } from '../../web/http-body.mjs';
import { definirMarca, marca } from '../../web/marca.mjs';
import { reloadModels } from '../../web/modelos-live.mjs';
import { SEGUE } from '../../web/rotas.mjs';
import { checkAi, writeAi } from '../ai-setup.mjs';
import { aiOf, endpoint, listModels, PROVIDERS } from '../providers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRANDS = { together: 'Together', openai: 'OpenAI', gemini: 'Google Gemini', deepinfra: 'DeepInfra', deepseek: 'DeepSeek' };
// Where the button is, in the words of the app's screen in each language.
const CHANGE_PATH = {
  pt: 'Configurações › Este computador › Trocar a IA ou o modelo',
  en: 'Settings › This computer › Change the AI or the model',
  es: 'Configuración › Esta computadora › Cambiar la IA o el modelo',
};

// The assistant has no other way of knowing which model answers for it: asked,
// it would guess from its training. The text is stable (it does not change
// between turns), so it does not break the provider's prompt cache.
export function systemNoteOf(info, language) {
  if (!info?.ai?.model) return null;
  const brand = BRANDS[info.ai.provider] || 'an OpenAI-compatible service';
  const where = CHANGE_PATH[String(language || '').slice(0, 2)] || CHANGE_PATH.en;
  return [
    `THIS INSTALLATION'S AI: you run on the model ${info.ai.model}, from ${brand}, chosen by the owner of this computer.`,
    'When asked which AI or model you are, answer exactly that; do not guess from your training.',
    `You cannot change it yourself: the owner changes the AI or the model in ${where}.`,
    info.audio && info.audio !== 'none'
      ? `Voice messages: ${BRANDS[info.audio]} transcribes the ones people send and speaks your replies when asked.`
      : `Voice messages are off: you cannot understand audio people send nor reply in voice; the owner turns them on in ${where}.`,
  ].join(' ');
}

// What runs now, read live: the AI from models.yaml, the audio from the config.
function current() {
  let ai = null;
  try { ai = aiOf(loadModels()); } catch {}
  return { ai, audio: audioProvider() || 'none' };
}

// A key already saved for this provider, so the page can leave the field empty.
// The key of "other" only goes back to the address it was saved for: an empty
// field with a new address must not send it to another service.
function savedKey(provider, url) {
  const keyVar = PROVIDERS[provider]?.keyVar;
  if (!keyVar || !process.env[keyVar]) return '';
  if (provider !== 'other') return process.env[keyVar];
  const ai = current().ai;
  return ai?.provider === 'other' && endpoint({ provider, url }).url === ai.url ? process.env[keyVar] : '';
}

// info = what the launcher tells (BRAMBIT_INSTALLATION); send = channel to it.
export function createInstallationPlugin({ info = readInfo(), sendToLauncher = process.send?.bind(process) } = {}) {
  return {
    nome: 'installation',
    app: [path.join(here, 'app')],
    siteTextos: [path.join(here, 'site-textos')],
    portas: () => (info ? { systemNote: ({ language }) => systemNoteOf({ ...info, ...current() }, language) } : {}),
    ligar({ rotas, send, sendHtml }) {
      if (!info) return;
      if (info.shared) definirMarca({ ...marca(), site: info.shared });
      const noCache = { 'cache-control': 'no-store' };
      const isOwner = async (ctx) => {
        const admin = String(process.env.ADMIN_EMAIL || '').toLowerCase();
        const u = admin ? await ctx.currentUser() : null;
        return Boolean(u && String(u.email || '').toLowerCase() === admin);
      };

      rotas.registrar('GET', '/api/installation', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        const { ai, audio } = current();
        send(res, 200, { ...info, ai: ai && { provider: ai.provider, model: ai.model }, audio }, noCache);
      });
      if (sendToLauncher) {
        rotas.registrar('POST', '/api/installation/shutdown', async (req, res, url, ctx) => {
          if (!(await isOwner(ctx))) return SEGUE;
          // Answers first and only then tells the launcher, which will stop this server.
          res.once('finish', () => sendToLauncher({ action: 'shutdown' }));
          send(res, 200, { ok: true }, noCache);
        });
      }

      // The AI change page. Signed out goes to the app's sign-in.
      rotas.registrar('GET', '/installation/ai', async (req, res, url, ctx) => {
        if (!(await ctx.currentUser())) { res.writeHead(302, { location: '/' }); return res.end(); }
        if (!(await isOwner(ctx))) return SEGUE;
        sendHtml(res, SETUP_PAGE, 200, await ctx.idiomaDaPagina?.(), { __MODE__: 'change' });
      });
      // The current choice, for the page to come with it selected. No key goes
      // to the browser: only which providers already have one saved.
      rotas.registrar('GET', '/api/installation/ai', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        const { ai, audio } = current();
        const savedKeys = Object.keys(PROVIDERS).filter((p) => p !== 'other' && process.env[PROVIDERS[p].keyVar]);
        if (ai?.provider === 'other' && process.env.OTHER_API_KEY) savedKeys.push('other');
        send(res, 200, { ...(ai ? { provider: ai.provider, model: ai.model, ...(ai.provider === 'other' ? { url: ai.url } : {}) } : {}), savedKeys, audio }, noCache);
      });
      // The models the key can use, for the page to offer (this also tests the key).
      rotas.registrar('POST', '/api/installation/models', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        const p = await readBody(req);
        const e = endpoint({ ...p, key: String(p.key || '').trim() || savedKey(p.provider, p.url) });
        if (e.error) return send(res, 400, { error: e.error }, noCache);
        const r = await listModels(e);
        send(res, r.ok ? 200 : 400, r.ok ? { models: r.models.map((m) => m.id), recommended: r.recommended } : { error: r.error, status: r.status }, noCache);
      });
      // Tests the choice and saves it; the server follows both files, the
      // models right away.
      rotas.registrar('POST', '/api/installation/ai', async (req, res, url, ctx) => {
        if (!(await isOwner(ctx))) return SEGUE;
        const r = await checkAi(await readBody(req), savedKey);
        if (r.error) return send(res, 400, { error: r.error, status: r.status }, noCache);
        try { writeAi(r, { configFile: configFilePath(), modelsFile: modelsFilePath() }); }
        catch (e) { if (e instanceof ConfigValueError) return send(res, 400, { error: 'key_rejected' }, noCache); throw e; }
        reloadModels();
        send(res, 200, { ok: true }, noCache);
      });
    },
  };
}

const SETUP_PAGE = path.join(here, '..', 'setup.html');

function readInfo() {
  try { return JSON.parse(process.env.BRAMBIT_INSTALLATION || 'null'); } catch { return null; }
}
