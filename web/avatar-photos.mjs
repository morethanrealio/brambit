// An assistant's face photo at the avatar service (vidu.mjs): registering it
// and keeping it alive. Vidu deletes a photo 90 days after it was created, so a
// photo older than RENEW_AFTER is registered again while nobody is talking to
// the avatar (the sweep in avatar.mjs), and one older than EXPIRES_AFTER is
// renewed before a session opens.
import * as viduApi from './vidu.mjs';

const DAY = 86400e3;
export const RENEW_AFTER = 80 * DAY;
export const EXPIRES_AFTER = 88 * DAY;

export const photoAge = (createdAt, now = Date.now()) => now - Date.parse(createdAt);

// Why a photo could not be registered, as the settings screen shows it:
// rejected = the service refused this photo (no clear face, bad file), the
// person needs another one; unavailable = the service failed or did not
// answer, the same photo may work later.
export function registrationError(e) {
  if (e?.code === 'photo_rejected' || e?.code === 'photo_not_ready') return e.code;
  return [400, 413, 415, 422].includes(e?.status) ? 'photo_rejected' : 'provider_unavailable';
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// → {id, createdAt, discarded} of a photo ready to open sessions with. A registration
// that does not get ready within `deadline` (it has been seen stuck on
// "created") or that is already old (the same content was registered long
// ago, and registering again returns that one) is deleted and done again, up
// to 3 times; `discarded` lists the ids deleted on the way, which another
// avatar with the same content may still point to. A failed one is deleted
// and not retried: it is the photo.
export async function registerReadyPhoto({ vidu, image, name, api = viduApi, now = Date.now, deadline = 40000, step = 1000, sleep = wait, log = () => {} }) {
  const discarded = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let photo = await api.registerPhoto(vidu, { image, name });
    const old = photoAge(photo.createdAt, now()) > RENEW_AFTER;
    const until = now() + deadline;
    while (!old && photo?.status !== 'success' && photo?.status !== 'failed' && now() <= until) {
      await sleep(step);
      photo = (await api.readPhoto(vidu, photo.id)) ?? { id: photo.id, status: 'failed' };
    }
    if (!old && photo.status === 'success') return { id: photo.id, createdAt: photo.createdAt, discarded };
    await api.deletePhoto(vidu, photo.id);
    discarded.push(photo.id);
    if (photo.status === 'failed') throw Object.assign(new Error('vidu: photo rejected'), { code: 'photo_rejected' });
    log(`[avatar] photo ${photo.id} ${old ? 'close to expiring' : 'not ready in time'}, registering again`);
  }
  throw Object.assign(new Error('vidu: the photo did not get ready'), { code: 'photo_not_ready' });
}
