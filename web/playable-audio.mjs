// AAC/M4A copy of an audio file, for players that can't open Ogg/Opus or WebM.
//
// Voice notes are stored as Ogg/Opus (what WhatsApp and Telegram take). The
// iPhone player (AVPlayer) only reads Ogg from iOS 27 on, so the mobile app asks
// /api/media for `format=m4a` and gets this copy instead. Nothing else changes:
// without the parameter the stored byte goes out as before.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Formats AVPlayer already plays; these go out untouched.
const ALREADY_PLAYABLE = /mp4|m4a|aac|mpeg|mp3|wav|x-caf/i;
// Larger than this is not a voice note; converting it would hold the request too long.
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export function needsM4a(contentType) {
  const ct = String(contentType || '');
  return /^audio\//i.test(ct) && !ALREADY_PLAYABLE.test(ct);
}

// The mp4 muxer needs to seek back to write the header (and `+faststart` moves it
// to the front so the player can start before the whole file arrives), so the
// output goes to a temp file instead of a pipe.
export function toM4a(input, { ffmpeg = 'ffmpeg', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `playable-${randomUUID()}.m4a`);
    const done = (buf) => { fs.rm(out, { force: true }, () => {}); resolve(buf); };
    let ff;
    try {
      ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-i', 'pipe:0', '-vn', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'ipod', out]);
    } catch { return done(null); }
    const timer = setTimeout(() => ff.kill('SIGKILL'), timeoutMs);
    ff.on('error', () => { clearTimeout(timer); done(null); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return done(null);
      fs.readFile(out, (err, buf) => done(err || !buf.length ? null : buf));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
}

// The player asks for the same file several times (a probe range, then the
// rest, then again when seeking), so the copy is kept in memory for a while.
// Holds the promise, so requests that arrive while ffmpeg runs share one job.
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const cache = new Map(); // cacheKey -> { promise, bytes }
let cachedBytes = 0;

function remember(cacheKey, promise) {
  const entry = { promise, bytes: 0 };
  cache.set(cacheKey, entry);
  promise.then((buf) => {
    if (cache.get(cacheKey) !== entry) return;
    if (!buf) { cache.delete(cacheKey); return; }
    entry.bytes = buf.length;
    cachedBytes += buf.length;
    for (const [k, e] of cache) {
      if (cachedBytes <= CACHE_MAX_BYTES || k === cacheKey) break;
      cache.delete(k);
      cachedBytes -= e.bytes;
    }
  });
  return promise;
}

// Returns `media` ({ buffer, contentType }) as M4A when it is audio the iPhone
// can't play; otherwise (or if the conversion fails) returns it unchanged.
export async function playableOnIos(key, media, convert = toM4a) {
  if (!media || !needsM4a(media.contentType) || media.buffer.length > MAX_INPUT_BYTES) return media;
  const cacheKey = `${key}:${media.buffer.length}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    cache.delete(cacheKey); cache.set(cacheKey, hit); // most recent goes last
  }
  const buf = await (hit ? hit.promise : remember(cacheKey, convert(media.buffer)));
  if (!buf) {
    console.error(`[media] m4a conversion failed for ${media.contentType}; sending the original`);
    return media;
  }
  return { ...media, buffer: buf, contentType: 'audio/mp4' };
}
