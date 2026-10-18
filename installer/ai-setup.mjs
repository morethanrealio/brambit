// The AI choice, shared by the launcher's first-run page and the "Change the AI
// or the model" page inside the app (installation plugin): test what the person
// chose, then write it where the server reads it. The keys and the audio go in
// the config file (BRAMBIT_CONFIG_FILE, keys encrypted with the vault) and the
// model in models.yaml; the running server follows both live.
import { writeFileSync } from 'node:fs';
import { writeConfig } from '../web/config-file.mjs';
import { audioChoice, choice, listModels, modelsYaml, PROVIDERS, testKey } from './providers.mjs';

// p = what the page sent; savedKey(provider) = the key already saved for that
// provider (an empty field keeps it) or ''. → {ok:true, ai, audio} or {error, status?}.
export async function checkAi(p, savedKey = () => '') {
  const filled = { ...p };
  if (!String(filled.key || '').trim()) filled.key = savedKey(filled.provider, filled.url);
  const c = choice(filled);
  if (c.error) return { error: c.error };
  const test = await testKey(c);
  if (!test.ok) return { error: test.error, status: test.status };
  const audioKey = String(p.audioKey || '').trim() || (p.audio && p.audio !== c.provider ? savedKey(p.audio) : '');
  const audio = audioChoice({ audio: p.audio, audioKey }, c);
  if (audio.error) return { error: audio.error };
  // A separate audio key is tested the same way, by listing what it can use.
  if (audio.key) {
    const t = await listModels({ provider: audio.provider, url: PROVIDERS[audio.provider].url, key: audio.key });
    if (!t.ok) return { error: `audio_${t.error}`, status: t.status };
  }
  return { ok: true, ai: { ...c, ...(test.price ? { price: test.price } : {}) }, audio };
}

// Writes a checked choice. The keys of other providers stay in the file: going
// back to one of them does not ask for its key again. The config file first, so
// the key is there when models.yaml starts pointing at it.
export function writeAi({ ai, audio }, { configFile, modelsFile, extra = {} }) {
  const keyVar = PROVIDERS[ai.provider].keyVar;
  const updates = { ...extra, [keyVar]: ai.key || null, BRAMBIT_AUDIO_PROVIDER: audio.provider };
  if (audio.key) updates[PROVIDERS[audio.provider].keyVar] = audio.key;
  writeConfig(updates, { file: configFile, encrypt: Object.keys(updates).filter((k) => k.endsWith('_API_KEY')) });
  writeFileSync(modelsFile, modelsYaml({ ...ai, key: Boolean(ai.key) }));
}
