// ── Services that follow the config file ──
// Some parts of the server run in the background only when their settings
// exist (the email reader, the WhatsApp worker). They used to be started once,
// at boot. A service registered here also starts when its settings appear in
// the config file, stops when they go away and restarts when it is pointed at
// something else (another inbox, another number), all without a restart.
//
// Changes settle before anything happens: an editor that saves in two steps,
// or a value removed and pasted back, must not switch a channel off and on.
// Start and stop never overlap: each service runs one action at a time.
//
// Without BRAMBIT_CONFIG_FILE nothing changes while the server runs, so this
// only does what boot did before.
import { onConfigChange } from './config-file.mjs';
import { emailEnabled } from './email.mjs';
import { waEnabled } from './whatsapp.mjs';
import { vaultEnabled } from './vault.mjs';
import { calendarWatchEnabled } from './calendar-watch.mjs';
import { instanceRoleMode, startAwsCredentialRefresh, stopAwsCredentialRefresh } from './aws-credentials.mjs';

// name: for the log. keys: settings that affect it. wanted(): whether it should
// run now. target(): what it points at (a change restarts it). start({ live })
// returns false when it did not start; live is true when it starts after boot.
export function registerLiveService({
  name, keys, wanted, target = () => '', start, stop, settleMs = 5000, log = console,
}) {
  const watched = new Set(keys);
  let running = false, current = null, timer = null, chain = Promise.resolve();

  const run = (fn) => (chain = chain.then(fn).catch((e) => log.error(`[live] ${name}:`, e?.message ?? e)));

  // The target is taken before starting: a change that lands while it starts
  // still counts as a change.
  const startNow = async (live) => {
    const next = target();
    running = (await start({ live })) !== false;
    current = running ? next : null;
  };

  function reconcile() {
    return run(async () => {
      const want = !!wanted();
      if (running && (!want || target() !== current)) {
        log.log(`[live] ${name}: ${want ? 'settings changed, restarting' : 'settings removed, stopping'}`);
        await stop();
        running = false;
        current = null;
      }
      if (!running && want) {
        log.log(`[live] ${name}: starting`);
        await startNow(true);
      }
    });
  }

  onConfigChange((changed) => {
    if (!changed.some((k) => watched.has(k))) return;
    clearTimeout(timer);
    timer = setTimeout(reconcile, settleMs);
    timer.unref?.();
  });

  return {
    // At boot: starts it if its settings are there, as before.
    boot: () => run(async () => {
      if (running) return;
      if (wanted()) await startNow(false);
      else log.log(`[live] ${name}: off until its settings are in the config`);
    }),
    get running() { return running; },
    // Tests: apply pending changes now.
    settle: () => { clearTimeout(timer); return reconcile(); },
  };
}

// Email channel. The password alone changing needs nothing (it is read on every
// read of the inbox); another address or server restarts the reader. Started
// after boot, it only answers mail that arrives from then on.
export const liveEmail = (poller, opts) => registerLiveService({
  name: 'email', ...opts,
  keys: ['EMAIL_ADDRESS', 'EMAIL_APP_PASSWORD', 'EMAIL_IMAP_HOST', 'EMAIL_IMAP_PORT'],
  wanted: emailEnabled,
  target: () => [process.env.EMAIL_ADDRESS, process.env.EMAIL_IMAP_HOST, process.env.EMAIL_IMAP_PORT].join('|'),
  start: ({ live }) => poller.start({ onlyNew: live }),
  stop: () => poller.stop(),
});

// WhatsApp worker (processes what the webhook stored in the inbox). The inbox is
// encrypted, so it needs the vault key too. Stopping waits for turns in
// progress. While it is stopped the webhook answers 503 and Meta sends the
// message again later; what was already stored is processed on the next start.
export const liveWhatsApp = (handler, opts) => registerLiveService({
  name: 'whatsapp', ...opts,
  keys: ['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET'],
  wanted: () => waEnabled() && vaultEnabled(),
  target: () => process.env.WA_PHONE_NUMBER_ID,
  start: () => handler.start(),
  stop: () => handler.stop(),
});

// Calendar change notice: first pass 2 minutes after it starts, then every 10.
// Stopping waits for a pass in progress. A person left unchecked for a while
// gets a new baseline on the way back, not notices (calendar-watch.mjs STALE_MS).
export function liveCalendarWatch(watch, opts = {}) {
  const log = opts.log ?? console;
  let first = null, every = null, pass = Promise.resolve();
  const tick = () => {
    pass = watch.tick()
      .then((r) => { if (r?.avisos) log.log(`[calendar-watch] notices: ${r.avisos}`); })
      .catch((e) => log.error('[calendar-watch]', e?.message ?? e));
  };
  return registerLiveService({
    name: 'calendar-watch', ...opts,
    keys: ['CALENDAR_WATCH'],
    wanted: calendarWatchEnabled,
    start: () => {
      first = setTimeout(tick, opts.firstMs ?? 2 * 60_000); first.unref?.();
      every = setInterval(tick, opts.everyMs ?? 10 * 60_000); every.unref?.();
    },
    stop: async () => { clearTimeout(first); clearInterval(every); await pass; },
  });
}

// S3 through the EC2 instance role (S3_INSTANCE_ROLE=1): keeps the role
// credential fresh while the flag is on. Without it, S3 uses the static keys.
export const liveAwsRole = (opts) => registerLiveService({
  name: 'aws-role', ...opts,
  keys: ['S3_INSTANCE_ROLE'],
  wanted: () => instanceRoleMode(),
  start: () => startAwsCredentialRefresh(),
  stop: () => stopAwsCredentialRefresh(),
});

// DeepSeek V4.1 Flash as a model the person can pick for an assistant. Ready
// only when its key answers; a new key is checked again, and turning it off
// hides the option. Assistants that already picked it get no other model in
// its place: they say it is unavailable.
export function liveDeepSeekFlash(key, opts = {}) {
  const log = opts.log ?? console;
  let ready = false;
  const svc = registerLiveService({
    name: 'deepseek-flash', ...opts,
    keys: ['DEEPSEEK_FLASH_ENABLED', 'DEEPSEEK_API_KEY'],
    wanted: () => !/^(0|false|off)$/i.test(process.env.DEEPSEEK_FLASH_ENABLED || ''),
    target: () => process.env.DEEPSEEK_API_KEY || '',
    start: async () => {
      try { await key(); ready = true; } catch {
        log.warn('[deepseek-flash] service credential unavailable; option hidden, no fallback for existing selections');
        return false;
      }
    },
    stop: () => { ready = false; },
  });
  return { boot: svc.boot, settle: svc.settle, get ready() { return ready; } };
}
