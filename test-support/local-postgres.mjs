// Guard for tests that need a REAL, disposable, local PostgreSQL (initdb + pg_ctl).
// Those tests never accept a connection URL: they create their own cluster on a
// Unix socket from TEST_POSTGRES_BIN. When that binary directory is absent, the
// test must SKIP with an explicit reason instead of failing the whole suite.
// Usage: test('...', {skip: postgresSkipReason()}, async () => {...})
import fs from 'node:fs';
import path from 'node:path';

export function postgresSkipReason(env = process.env) {
  const bin = env.TEST_POSTGRES_BIN;
  if (!bin) return 'TEST_POSTGRES_BIN not set: needs local PostgreSQL binaries (initdb, pg_ctl); remote DBs are never used';
  if (!path.isAbsolute(bin)) return `TEST_POSTGRES_BIN must be an absolute local directory, got "${bin}"`;
  for (const tool of ['initdb', 'pg_ctl']) {
    try { fs.accessSync(path.join(bin, tool), fs.constants.X_OK); }
    catch { return `TEST_POSTGRES_BIN=${bin} has no executable ${tool}`; }
  }
  return false;
}
