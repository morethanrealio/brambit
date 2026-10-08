// Findings #15 and #16 from the 2026-09-16 sweep.
//
// #15 — "yes with a caveat": the person authorizes, BUT changes the request ("pode, mas
// manda pro outro endereço"). The "pode sim" matched the strong-authorization list and
// the server executed the PENDING action, which was still the OLD version: the correction
// she had just written was silently discarded.
//
// #16 — creating a Google Doc and exporting a PDF wrote to the person's Drive without going
// through the confirmation gate. The only guard was a sentence in the description asking
// the model to confirm, which is a request, not a gate.
//
// Offline: only the deterministic parser and the lists. No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isConfirmation, confirmacaoComRessalva, GATED_TOOLS, IRREVERSIBLE_TOOLS,
} from './web/confirm.mjs';

test('#15 authorizing while changing the request does not confirm the pending action', () => {
  const casos = [
    'pode sim, mas manda pro outro endereço',
    'pode, mas manda para outro e-mail',
    'confirmo, mas troca o valor',
    'sim, porém muda a data',
    'ok, só que corrige o nome antes',
    'pode enviar, mas para outra pessoa',
    'sim, manda em vez do João pro Pedro',
    'yes, but send it to another address',
    'sí, pero mándalo a otra dirección',
    'pode mandar, no lugar de amanhã manda hoje',
  ];
  for (const t of casos) {
    assert.equal(isConfirmation(t), false, `could not confirm: ${t}`);
    assert.equal(confirmacaoComRessalva(t), true, `was a caveat: ${t}`);
  }
});

test("#15 a caveat without a change keeps confirming (can't become a blanket cancellation)", () => {
  const casos = [
    'nunca se sabe, mas pode mandar',        // was already in confirm.test.mjs
    'tá corrido aqui, mas pode enviar',
    'confirmo, mas avisa quando terminar',
    'pode subir, mas sem pressa',
    'busy day, but go ahead',
  ];
  for (const t of casos) {
    assert.equal(isConfirmation(t), true, `had to confirm: ${t}`);
    assert.equal(confirmacaoComRessalva(t), false, `was not a caveat: ${t}`);
  }
});

test("#15 a change BEFORE the 'but' does not cancel (the caveat is what confirms)", () => {
  assert.equal(isConfirmation('mudei de ideia ontem, mas pode mandar'), true);
});

test('#15 a refusal stays a refusal, not a "caveat"', () => {
  for (const t of ['não, manda pro outro endereço', 'cancela, troca o valor']) {
    assert.equal(isConfirmation(t), false);
    assert.equal(confirmacaoComRessalva(t), false, `refusal is not a caveat: ${t}`);
  }
});

test('#15 the server tells the model the request CHANGED, instead of "did not confirm"', () => {
  const server = fs.readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /confirmacaoComRessalva/);
  assert.match(server, /autorizou, mas MUDANDO o pedido/);
});

test('#16 creating a doc and exporting a PDF to Drive go through the confirmation gate', () => {
  for (const t of ['docs_create', 'drive_export_pdf']) {
    assert.ok(GATED_TOOLS.has(t), `${t} had to be gated`);
    // Same treatment as drive_upload, which was already gated: writing to Drive is
    // undoable, so 👍 confirms. It's not an irreversible action.
    assert.ok(!IRREVERSIBLE_TOOLS.has(t), `${t} is not irreversible (same as drive_upload)`);
  }
  assert.ok(GATED_TOOLS.has('drive_upload'), 'drive_upload precedent is gone');
});

test("#16 both have their own text in the proposal and the completion", () => {
  const src = fs.readFileSync(new URL('./web/confirm.mjs', import.meta.url), 'utf8');
  for (const t of ['docs_create', 'drive_export_pdf']) {
    assert.equal(src.split(`case '${t}':`).length - 1, 2, `${t}: missing describe or describeDone`);
  }
});
