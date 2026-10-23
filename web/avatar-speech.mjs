// Turning an assistant's reply into what its avatar says (avatar-live.mjs):
// the reply is Markdown written for the chat screen, so links, code, list
// marks and emoji leave before it becomes speech; the speech is made a few
// sentences at a time (the first one short, so the face starts talking
// soon) and goes to the avatar service at the pace it plays.
import { FRAME_BYTES, SAMPLE_RATE } from './vidu.mjs';

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;   // PCM s16le mono

// Markdown → plain sentences to be spoken, at most `max` characters (cut at
// the end of a sentence when there is one in the second half).
export function spokenText(markdown, { max = 2000 } = {}) {
  let t = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]\n]*\]\([^)\s]*\)/g, ' ')
    .replace(/\[([^\]\n]*)\]\((?:https?:|mailto:)[^)\s]*\)/g, '$1')
    .replace(/<?\bhttps?:\/\/[^\s<>]+>?/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .replace(/(\*\*|\*|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w])__?(?=\S)([^\n]*?\S)__?(?!\w)/g, '$1$2')
    .replace(/\p{Extended_Pictographic}\uFE0F?|\u200D/gu, '');
  // A line with no closing mark (a list item, a heading) ends a sentence.
  t = t.split('\n').map((line) => line.replace(/^[\s,]+|[\s,]+$/g, '')).filter(Boolean)
    .map((line) => (/[.!?…:;]["')\]]*$/.test(line) ? line : `${line}.`)).join(' ')
    .replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 2 ? cut.slice(0, end + 1) : cut.trimEnd();
}

// Text → the pieces made into speech one at a time: whole sentences, the first
// piece up to `first` characters and the others up to `max`. A sentence longer
// than that is split at a comma or a space.
export function speechChunks(text, { first = 160, max = 300 } = {}) {
  const pieces = [];
  for (const sentence of String(text).split(/(?<=[.!?…]["')\]]*)\s+/)) {
    let s = sentence.trim();
    while (s.length > max) {
      const at = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf(' ', max));
      const cut = at > max / 2 ? at + 1 : max;
      pieces.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) pieces.push(s);
  }
  const chunks = [];
  for (const p of pieces) {
    const limit = chunks.length === 1 ? first : max;
    if (chunks.length && chunks.at(-1).length + 1 + p.length <= limit) chunks[chunks.length - 1] += ` ${p}`;
    else chunks.push(p);
  }
  return chunks;
}

// PCM → frames of 100 ms; the last one may be shorter (always whole samples).
export function* toFrames(pcm, size = FRAME_BYTES) {
  for (let i = 0; i < pcm.length; i += size) {
    const frame = pcm.subarray(i, Math.min(i + size, pcm.length));
    yield frame.length % 2 ? frame.subarray(0, frame.length - 1) : frame;
  }
}

export function wait(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Sends frames on the clock of the speech, `lead` ms ahead so the avatar
// never runs dry, starting no earlier than `startAt` (when the previous piece
// ends playing). → when the last sample ends playing, in Date.now() time.
export async function sendPaced(frames, send, { signal, startAt = 0, lead = 300, now = Date.now, sleep = wait } = {}) {
  const t0 = Math.max(now(), startAt);
  let ms = 0;
  for (const frame of frames) {
    if (signal?.aborted) break;
    send(frame);
    ms += frame.length / BYTES_PER_MS;
    const ahead = t0 + ms - lead - now();
    if (ahead > 0) await sleep(ahead, signal);
  }
  return t0 + ms;
}
