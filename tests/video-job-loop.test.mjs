import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decidirCobrancaNaoConcluida, decidirFalhaNaEntrega, LIMITE_ENTREGA_MS } from '../web/video-poll-decisao.mjs';

// Finding #25: a video job that failed on delivery stayed 'queued' forever, the
// poller would downgrade/re-upload the mp4 every minute, and the owner could never
// request another video again (limit of 1 in progress per person).

test('charge already finalized needs no action (does not repeat on its own)', () => {
  assert.equal(decidirCobrancaNaoConcluida('already_final').acao, 'seguir');
  assert.equal(decidirCobrancaNaoConcluida('not_found').acao, 'seguir');
});

test('charge suspended for review TAKES the job OUT of the active queue', () => {
  for (const motivo of ['legacy_charge_needs_review', 'inconsistent_charge_needs_review']) {
    const d = decidirCobrancaNaoConcluida(motivo);
    assert.equal(d.acao, 'revisar', `${motivo} cannot stay in the queue: it would repeat forever`);
    assert.match(d.erro, new RegExp(motivo));
  }
});

test('unknown reason also leaves the queue instead of repeating', () => {
  assert.equal(decidirCobrancaNaoConcluida('').acao, 'revisar');
  assert.equal(decidirCobrancaNaoConcluida(undefined).acao, 'revisar');
});

test('recent failure retries (a network hiccup deserves a retry)', () => {
  assert.equal(decidirFalhaNaEntrega({ idadeMs: 60_000, mensagem: 'ECONNRESET' }).acao, 'tentar_de_novo');
  assert.equal(decidirFalhaNaEntrega({ idadeMs: LIMITE_ENTREGA_MS - 1 }).acao, 'tentar_de_novo');
});

test('a failure that persists past the deadline gives up and says why', () => {
  const d = decidirFalhaNaEntrega({ idadeMs: LIMITE_ENTREGA_MS, mensagem: 'putMedia 500' });
  assert.equal(d.acao, 'desistir');
  assert.match(d.erro, /30 min/);
  assert.match(d.erro, /putMedia 500/);
});

test('with no request date, gives up instead of becoming an endless loop', () => {
  assert.equal(decidirFalhaNaEntrega({ idadeMs: NaN }).acao, 'desistir');
  assert.equal(decidirFalhaNaEntrega({}).acao, 'desistir');
});

test('a huge message does not overflow the error column', () => {
  const d = decidirFalhaNaEntrega({ idadeMs: LIMITE_ENTREGA_MS, mensagem: 'x'.repeat(5000) });
  assert.ok(d.erro.length < 400, `error with ${d.erro.length} chars`);
});

test('the poller uses both decisions and marks status on both paths', () => {
  const src = fs.readFileSync(new URL('../web/server.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('async function pollVideoJobs()');
  assert.ok(i > 0);
  const trecho = src.slice(i, src.indexOf('// ── Broadcast do admin', i));
  assert.match(trecho, /decidirCobrancaNaoConcluida\(settlement\.reason\)/);
  assert.match(trecho, /status: 'needs_review'/);
  assert.match(trecho, /decidirFalhaNaEntrega\(\{ idadeMs: Date\.now\(\) - new Date\(job\.created_at\)/);
  assert.match(trecho, /decisao\.acao === 'desistir'/);
  // The settled:false branch must NOT silently leave the job active anymore.
  assert.ok(!/needs_review'\)\) console\.error/.test(trecho), 'old branch still present');
});
