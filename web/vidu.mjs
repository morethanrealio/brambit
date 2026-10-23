// Vidu (vidu.com), the service that animates an assistant's face: given a photo
// and the speech audio, it draws the talking face live. Brambit keeps the
// brain, the voice and the transcription; Vidu only draws.
// Off unless VIDU_API_KEY is set. VIDU_HOST picks the account's region
// (api.vidu.com by default, api.vidu.cn for an account opened there).
// Docs: platform.vidu.com, S2-Avatar > Component and Image Upload.
//
// Photos (/live/v1/avatars): registering a photo returns its avatar id, which
// opens a session in about 3 s (a raw photo takes about 15 s). Registration is
// by content: sending the same photo again returns the id that already exists,
// with its original creation date. Vidu deletes a photo 90 days after it was
// created, so callers renew it before that (avatar-photos.mjs).

export function viduConfig({ key = process.env.VIDU_API_KEY, host = process.env.VIDU_HOST } = {}) {
  key = String(key || '').trim();
  if (!key) return null;
  return { host: String(host || '').trim() || 'api.vidu.com', key };
}

// Ids are int64: a big number loses precision in JSON.parse, so it is quoted first.
const parse = (body) => JSON.parse(String(body).replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"'));

async function call({ host, key, fetchImpl = fetch }, method, route, body) {
  const res = await fetchImpl(`https://${host}${route}`, {
    method,
    headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`vidu ${res.status}: ${text.slice(0, 300)}`), { status: res.status, body: text });
  return text;
}

const photoOf = (body) => {
  const d = parse(body);
  if (d?.id == null) throw new Error(`vidu: photo reply without id (${String(body).slice(0, 200)})`);
  return { id: String(d.id), status: d.status, createdAt: d.created_at };
};

// image: data URI (data:image/jpeg;base64,...). status: created → success | failed.
export async function registerPhoto(vidu, { image, name }) {
  return photoOf(await call(vidu, 'POST', '/live/v1/avatars', { image_uri: image, name }));
}

// null: the photo no longer exists (deleted or expired).
export async function readPhoto(vidu, id) {
  try {
    return photoOf(await call(vidu, 'GET', `/live/v1/avatars/${encodeURIComponent(id)}`));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function deletePhoto(vidu, id) {
  await call(vidu, 'DELETE', `/live/v1/avatars/${encodeURIComponent(id)}`).catch((e) => { if (e.status !== 404) throw e; });
}
