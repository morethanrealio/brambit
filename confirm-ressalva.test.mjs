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

test('#15 autorizar mudando o pedido não confirma a ação pendente', () => {
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
    assert.equal(isConfirmation(t), false, `não podia confirmar: ${t}`);
    assert.equal(confirmacaoComRessalva(t), true, `era ressalva: ${t}`);
  }
});

test('#15 ressalva sem troca continua confirmando (não pode virar cancelamento geral)', () => {
  const casos = [
    'nunca se sabe, mas pode mandar',        // was already in confirm.test.mjs
    'tá corrido aqui, mas pode enviar',
    'confirmo, mas avisa quando terminar',
    'pode subir, mas sem pressa',
    'busy day, but go ahead',
  ];
  for (const t of casos) {
    assert.equal(isConfirmation(t), true, `tinha que confirmar: ${t}`);
    assert.equal(confirmacaoComRessalva(t), false, `não era ressalva: ${t}`);
  }
});

test('#15 troca ANTES da adversativa não cancela (a ressalva é que confirma)', () => {
  assert.equal(isConfirmation('mudei de ideia ontem, mas pode mandar'), true);
});

test('#15 recusa continua sendo recusa, não "ressalva"', () => {
  for (const t of ['não, manda pro outro endereço', 'cancela, troca o valor']) {
    assert.equal(isConfirmation(t), false);
    assert.equal(confirmacaoComRessalva(t), false, `recusa não é ressalva: ${t}`);
  }
});

test('#15 o servidor explica ao modelo que o pedido MUDOU, em vez de "não confirmou"', () => {
  const server = fs.readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /confirmacaoComRessalva/);
  assert.match(server, /autorizou, mas MUDANDO o pedido/);
});

test('#16 criar doc e exportar PDF no Drive passam pelo portão de confirmação', () => {
  for (const t of ['docs_create', 'drive_export_pdf']) {
    assert.ok(GATED_TOOLS.has(t), `${t} tinha que ser gated`);
    // Same treatment as drive_upload, which was already gated: writing to Drive is
    // undoable, so 👍 confirms. It's not an irreversible action.
    assert.ok(!IRREVERSIBLE_TOOLS.has(t), `${t} não é irreversível (igual drive_upload)`);
  }
  assert.ok(GATED_TOOLS.has('drive_upload'), 'precedente do drive_upload sumiu');
});

test('#16 as duas têm texto próprio na proposta e na conclusão', () => {
  const src = fs.readFileSync(new URL('./web/confirm.mjs', import.meta.url), 'utf8');
  for (const t of ['docs_create', 'drive_export_pdf']) {
    assert.equal(src.split(`case '${t}':`).length - 1, 2, `${t}: falta describe ou describeDone`);
  }
});
