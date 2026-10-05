import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decidirCobrancaNaoConcluida, decidirFalhaNaEntrega, LIMITE_ENTREGA_MS } from './web/video-poll-decisao.mjs';

// Achado #25: job de vídeo que falha na entrega ficava 'queued' pra sempre, o
// poller rebaixava/resubia o mp4 a cada minuto e o dono nunca mais conseguia
// pedir outro vídeo (limite de 1 em andamento por pessoa).

test('cobranca ja finalizada nao precisa de acao (nao repete sozinha)', () => {
  assert.equal(decidirCobrancaNaoConcluida('already_final').acao, 'seguir');
  assert.equal(decidirCobrancaNaoConcluida('not_found').acao, 'seguir');
});

test('cobranca suspensa para revisao TIRA o job da fila ativa', () => {
  for (const motivo of ['legacy_charge_needs_review', 'inconsistent_charge_needs_review']) {
    const d = decidirCobrancaNaoConcluida(motivo);
    assert.equal(d.acao, 'revisar', `${motivo} nao pode ficar na fila: repetiria pra sempre`);
    assert.match(d.erro, new RegExp(motivo));
  }
});

test('motivo desconhecido tambem sai da fila em vez de repetir', () => {
  assert.equal(decidirCobrancaNaoConcluida('').acao, 'revisar');
  assert.equal(decidirCobrancaNaoConcluida(undefined).acao, 'revisar');
});

test('falha recente tenta de novo (soluco de rede merece retry)', () => {
  assert.equal(decidirFalhaNaEntrega({ idadeMs: 60_000, mensagem: 'ECONNRESET' }).acao, 'tentar_de_novo');
  assert.equal(decidirFalhaNaEntrega({ idadeMs: LIMITE_ENTREGA_MS - 1 }).acao, 'tentar_de_novo');
});

test('falha que persiste alem do prazo desiste e diz por que', () => {
  const d = decidirFalhaNaEntrega({ idadeMs: LIMITE_ENTREGA_MS, mensagem: 'putMedia 500' });
  assert.equal(d.acao, 'desistir');
  assert.match(d.erro, /30 min/);
  assert.match(d.erro, /putMedia 500/);
});

test('sem data do pedido desiste em vez de virar loop sem fim', () => {
  assert.equal(decidirFalhaNaEntrega({ idadeMs: NaN }).acao, 'desistir');
  assert.equal(decidirFalhaNaEntrega({}).acao, 'desistir');
});

test('mensagem gigante nao estoura a coluna error', () => {
  const d = decidirFalhaNaEntrega({ idadeMs: LIMITE_ENTREGA_MS, mensagem: 'x'.repeat(5000) });
  assert.ok(d.erro.length < 400, `erro com ${d.erro.length} chars`);
});

test('o poller usa as duas decisoes e marca status nos dois caminhos', () => {
  const src = fs.readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('async function pollVideoJobs()');
  assert.ok(i > 0);
  const trecho = src.slice(i, src.indexOf('// ── Broadcast do admin', i));
  assert.match(trecho, /decidirCobrancaNaoConcluida\(settlement\.reason\)/);
  assert.match(trecho, /status: 'needs_review'/);
  assert.match(trecho, /decidirFalhaNaEntrega\(\{ idadeMs: Date\.now\(\) - new Date\(job\.created_at\)/);
  assert.match(trecho, /decisao\.acao === 'desistir'/);
  // O ramo de settled:false NÃO pode mais sair calado deixando o job ativo.
  assert.ok(!/needs_review'\)\) console\.error/.test(trecho), 'ramo antigo ainda presente');
});
