// Figures out the image type from the BYTES, not from what the client claims it
// sent. The payload's `mimeType` is free text: any file declared 'image/png' used
// to pass. For a biometric photo this matters twice (what goes into the bucket
// and what the video worker will read), so here the content has the final say.
// Returns { mime, ext } or null when it's not an image in a format we accept.
// Used by the owner's chat uploads (server.mjs) and the public web channel (extensions/public-support/public-web.mjs).
export function sniffImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  // HEIC/HEIF (the iPhone's own photo format): 'ftyp' box at byte 4 + a known brand.
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const marca = buf.subarray(8, 12).toString('latin1').toLowerCase();
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1'].includes(marca)) return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}
