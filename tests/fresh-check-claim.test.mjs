// "Conferi agora" guards (rule + Jev #48) against queries the platform ran in
// the turn. Offline: the judge is a stub, no Jev call, no LLM.
// Cases of 05/10 and 07/10: "busca_email" routines got "I did not consult any
// tool" although the platform had fetched the emails, and the rule then only
// moved that notice below the "E-mails consultados" footer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceFreshCheckClaims, judgeFreshCheckClaim, freshCheckCorrection } from '../web/turn-claim-guard.mjs';
import { turnSearchCoverage } from '../web/turn-search-coverage.mjs';

const CORRECTION = freshCheckCorrection('pt-BR');
const stubJudge = (choice) => {
  const judge = async () => { judge.calls++; return choice; };
  judge.calls = 0;
  return judge;
};
const routineReply = 'Busquei nos e-mails dos últimos 7 dias por fatura, boleto e cobrança e não há nenhuma conta a pagar. Nada vencendo nos próximos 5 dias.';
const emailRow = { provider: 'gmail', account: 'fixture@example.invalid', id: 'synthetic-1',
  link: 'https://mail.google.com/mail/#all/synthetic-1', subject: 'Newsletter sintética', from: 'news@example.invalid', read: true };

// Same order as the server: Jev, then searchCoverage.finish (footer), then the rule.
async function guardTurn(text, { toolCounts = {}, platformChecks = new Set(), judge, emails = [] }) {
  const coverage = turnSearchCoverage();
  coverage.observeEmail(emails);
  const afterJudge = await judgeFreshCheckClaim(text, { toolCounts, platformChecks, language: 'pt-BR', judge });
  const withFooter = coverage.finish(afterJudge, 'pt-BR');
  const afterRule = enforceFreshCheckClaims(withFooter, { toolCounts, platformChecks, language: 'pt-BR' });
  return { afterJudge, withFooter, afterRule };
}

test('FP: email pre-search run by the platform counts as a fresh check, the reply stays', async () => {
  const judge = stubJudge('alegacao_falsa');
  const { afterJudge, withFooter, afterRule } = await guardTurn(routineReply,
    { platformChecks: new Set(['busca_email']), judge, emails: [emailRow] });
  assert.equal(judge.calls, 0, 'the judge is not asked when the platform consulted in the turn');
  assert.equal(afterJudge, routineReply);
  assert.match(withFooter, /E-mails consultados/);
  assert.equal(afterRule, withFooter);
  assert.doesNotMatch(afterRule, /Não consultei nenhuma ferramenta/);
  // An explicit "verifiquei agora" is true here too.
  const explicit = 'Verifiquei agora os e-mails das últimas 24 horas e nenhuma nota fiscal chegou.';
  assert.equal(enforceFreshCheckClaims(explicit, { platformChecks: new Set(['busca_email']) }), explicit);
});

test('FP: a search with zero results is still a query of the turn', async () => {
  const judge = stubJudge('alegacao_falsa');
  const { afterRule } = await guardTurn('Busquei nos e-mails de hoje e não chegou nenhuma nota fiscal.',
    { platformChecks: new Set(['busca_email']), judge });
  assert.equal(judge.calls, 0);
  assert.doesNotMatch(afterRule, /Não consultei nenhuma ferramenta/);
});

test('FP: native search sources count as a fresh check', async () => {
  const judge = stubJudge('alegacao_falsa');
  const text = 'Conferi agora o site oficial: o evento continua marcado para sábado.';
  const { afterRule } = await guardTurn(text, { platformChecks: new Set(['busca_nativa']), judge });
  assert.equal(judge.calls, 0);
  assert.equal(afterRule, text);
});

test('the rule never moves its own notice: only repositioning is not a cut', () => {
  const legacy = [routineReply, CORRECTION, 'E-mails consultados:\n- [Newsletter sintética](https://mail.google.com/mail/#all/synthetic-1)'].join('\n\n');
  assert.equal(enforceFreshCheckClaims(legacy, { toolCounts: {} }), legacy);
  for (const language of ['en', 'es']) {
    const text = `Summary.\n\n${freshCheckCorrection(language)}\n\nSources: example`;
    assert.equal(enforceFreshCheckClaims(text, { language }), text, language);
  }
});

test('Jev notice is added once and the rule keeps it in place after the footer', async () => {
  const judge = stubJudge('alegacao_falsa');
  const text = 'Acabei de conferir sua agenda e a tarde está livre.';
  const { afterJudge, afterRule } = await guardTurn(text, { judge, emails: [emailRow] });
  assert.equal(judge.calls, 1);
  assert.equal(afterJudge, `${text}\n\n${CORRECTION}`);
  assert.equal(afterRule.split(CORRECTION).length, 2, 'exactly one notice');
  assert.ok(afterRule.indexOf(CORRECTION) < afterRule.indexOf('E-mails consultados'), 'not moved below the footer');
  // A text that already carries the notice is not judged again.
  const again = stubJudge('alegacao_falsa');
  assert.equal(await judgeFreshCheckClaim(afterJudge, { judge: again }), afterJudge);
  assert.equal(again.calls, 0);
});

test('VP: no query in the turn, "verifiquei agora" is still cut', async () => {
  const claim = 'Verifiquei agora: sua assinatura continua ativa.';
  const text = `Oi!\n${claim}\nQualquer dúvida, me chame.`;
  const judge = stubJudge('ok');
  const { afterRule } = await guardTurn(text, { judge });
  assert.equal(judge.calls, 0, 'the rule handles explicit claims, the judge is not needed');
  assert.ok(!afterRule.includes(claim));
  assert.ok(afterRule.includes('Qualquer dúvida, me chame.'));
  assert.ok(afterRule.endsWith(CORRECTION));
  // A notice copied from history doesn't duplicate the correction.
  const copied = `${claim}\n\n${CORRECTION}`;
  assert.equal(enforceFreshCheckClaims(copied, {}), CORRECTION);
});

test('VP: no query in the turn, the judge flags an implicit claim', async () => {
  const text = 'Acabei de conferir sua conta e o saldo está positivo.';
  assert.equal(await judgeFreshCheckClaim(text, { judge: stubJudge('alegacao_falsa') }), `${text}\n\n${CORRECTION}`);
  assert.equal(await judgeFreshCheckClaim(text, { judge: stubJudge('ok') }), text);
  assert.equal(await judgeFreshCheckClaim(text, { judge: null }), text, 'Jev off keeps the old behavior');
  assert.equal(await judgeFreshCheckClaim(text, { toolCounts: { status_conta: 1 }, judge: stubJudge('alegacao_falsa') }), text);
});
