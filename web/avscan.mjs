// Antivírus de uploads (ASVS L1). Escaneia o byte de um arquivo enviado pelo
// usuário contra o ClamAV via protocolo INSTREAM do clamd, sem dependência
// externa (só node:net). O clamd roda como daemon local no host; a gente fala
// com ele pelo socket unix (CLAMD_SOCKET) ou por TCP (CLAMD_HOST:CLAMD_PORT).
//
// Comportamento:
//   - Sem CLAMD_SOCKET/CLAMD_HOST setado → no-op (clean, skipped). Dev/local
//     não quebra e nada é bloqueado por engano.
//   - Vírus detectado (FOUND) → { clean: false, signature }. O caller REJEITA.
//   - clamd fora do ar / erro de socket / timeout → fail-open (clean, skipped,
//     error) pra não derrubar o upload por indisponibilidade do daemon; o motivo
//     fica logado. Só uma detecção positiva bloqueia.
import net from 'net';

// StreamMaxLength padrão do clamd é 25MB; acima disso ele corta o stream. A
// gente pula o scan de arquivos maiores (raro nesse app) e loga.
const MAX_SCAN = 25 * 1024 * 1024;

export function avEnabled() {
  return !!(process.env.CLAMD_SOCKET || process.env.CLAMD_HOST);
}

// Escaneia um Buffer. Resolve sempre (nunca rejeita) com:
//   { clean: true }                          arquivo limpo
//   { clean: false, signature }              vírus encontrado
//   { clean: true, skipped: true, error? }   scan pulado (desligado/grande/erro)
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

    // clamd responde uma linha terminada em \0 e fecha. Interpreta assim que a
    // resposta completa chega (\0) ou no fechamento do socket, o que vier antes.
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
      // INSTREAM: comando, depois chunks (len BE de 4 bytes + bytes), depois len 0.
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
