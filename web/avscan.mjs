// Upload antivirus (ASVS L1). Scans the bytes of a file the user uploaded
// against ClamAV via clamd's INSTREAM protocol, with no external dependency
// (just node:net). clamd runs as a local daemon on the host; we talk to it
// over a unix socket (CLAMD_SOCKET) or over TCP (CLAMD_HOST:CLAMD_PORT).
//
// Behavior:
//   - With no CLAMD_SOCKET/CLAMD_HOST set → no-op (clean, skipped). Dev/local
//     does not break and nothing is blocked by mistake.
//   - Virus detected (FOUND) → { clean: false, signature }. The caller REJECTS.
//   - clamd down / socket error / timeout → fail-open (clean, skipped, error)
//     so the upload is not brought down by the daemon being unavailable; the
//     reason stays logged. Only a positive detection blocks.
import net from 'net';

// clamd's default StreamMaxLength is 25MB; above that it cuts the stream. We
// skip scanning larger files (rare in this app) and log it.
const MAX_SCAN = 25 * 1024 * 1024;

export function avEnabled() {
  return !!(process.env.CLAMD_SOCKET || process.env.CLAMD_HOST);
}

// Scans a Buffer. Always resolves (never rejects) with:
//   { clean: true }                          clean file
//   { clean: false, signature }              virus found
//   { clean: true, skipped: true, error? }   scan skipped (off/large/error)
export function scanBuffer(buffer, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!avEnabled()) return resolve({ clean: true, skipped: true });
    if (!buffer || !buffer.length) return resolve({ clean: true, skipped: true });
    if (buffer.length > MAX_SCAN) return resolve({ clean: true, skipped: true, error: `arquivo grande demais p/ scan (${buffer.length} bytes)` });

    const conn = process.env.CLAMD_SOCKET
      ? { path: process.env.CLAMD_SOCKET }
      : { host: process.env.CLAMD_HOST, port: Number(process.env.CLAMD_PORT || 3310) };

    let resp = '';
    let done = false;
    const sock = net.connect(conn);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { } resolve(r); };
    const timer = setTimeout(() => finish({ clean: true, skipped: true, error: 'timeout no clamd' }), timeoutMs);

    // clamd answers with one line ending in \0 and closes. Parses as soon as
    // the complete response arrives (\0) or on the socket's close, whichever
    // comes first.
    const parse = () => {
      const line = resp.replace(/\0/g, '').trim();
      if (!line) return finish({ clean: true, skipped: true, error: 'resposta vazia do clamd' });
      if (/FOUND$/.test(line)) {
        const m = /:\s*(.+)\s+FOUND$/.exec(line);
        return finish({ clean: false, signature: m ? m[1] : 'desconhecido' });
      }
      if (/\bOK$/.test(line)) return finish({ clean: true });
      finish({ clean: true, skipped: true, error: `resposta inesperada do clamd: ${line}` });
    };
    sock.on('error', (e) => finish({ clean: true, skipped: true, error: `clamd indisponível: ${e.message}` }));
    sock.on('data', (d) => { resp += d.toString('utf8'); if (resp.includes('\0')) parse(); });
    sock.on('end', () => parse());
    sock.on('connect', () => {
      // INSTREAM: command, then chunks (4-byte BE len + bytes), then len 0.
      sock.write('zINSTREAM\0');
      const CH = 64 * 1024;
      for (let i = 0; i < buffer.length; i += CH) {
        const chunk = buffer.subarray(i, i + CH);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      const zero = Buffer.alloc(4);
      zero.writeUInt32BE(0);
      sock.write(zero);
    });
  });
}
