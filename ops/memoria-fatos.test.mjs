// Tests for the keyed facts layer (memory v2, Phase 1). Pure: doesn't touch the database.
// Run: node ops/memoria-fatos.test.mjs   (needs node_modules because of db.mjs)
import { aplicarOps, expandirDefinir, normAssunto, parseDesde, linhaDoFato, valorDaLinha, trocarNaLinha } from '../web/wiki.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; } else { fail++; console.log(`FALHOU: ${nome}`); } };
const rodar = (ops, fatos, paginas) => {
  const e = expandirDefinir(ops, fatos, paginas);
  return { e, r: aplicarOps(e.ops, paginas, { maxOps: e.ops.length }) };
};

t('normAssunto', normAssunto('Cidade onde Mora!') === 'cidade_onde_mora');
t('parseDesde day', parseDesde('2026-09-01')?.txt === '01/09/2026');
t('parseDesde month', parseDesde('2026-09')?.iso === '2026-09-01' && parseDesde('2026-09').txt === '09/2026');
t('parseDesde br', parseDesde('05/03/2025')?.iso === '2025-03-05');
t('parseDesde garbage = null', parseDesde('semana passada') === null);
t('linhaDoFato', linhaDoFato('Mora em Curitiba', '09/2026', 'Mora em SP') === '- Mora em Curitiba (desde 09/2026; antes: Mora em SP)');
t('valorDaLinha strips suffix', valorDaLinha('- Mora em Curitiba (desde 09/2026; antes: Mora em SP)') === 'Mora em Curitiba');

// fato novo = add
{
  const { e, r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Mora em São Paulo' }], [], { perfil: '- trabalha com produto' });
  t('new one becomes add', r.paginas.perfil === '- trabalha com produto\n- Mora em São Paulo');
  t('new one marks the change with the index', r.mudancas[0].fato === 0 && e.definicoes[0].assunto === 'cidade');
}
// same subject, new value = replaces the line (doesn't accumulate)
{
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Mora em São Paulo', pagina: 'perfil', linha_pagina: '- Mora em São Paulo' }];
  const { r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Mora em Curitiba', desde: '2026-09' }], fatos,
    { perfil: '- trabalha com produto\n- Mora em São Paulo\n- treina de manhã' });
  t('swaps in place', r.paginas.perfil === '- trabalha com produto\n- Mora em Curitiba (desde 09/2026; antes: Mora em São Paulo)\n- treina de manhã');
  t('old one disappears from the page', !r.paginas.perfil.includes('- Mora em São Paulo\n'));
}
// mesmo valor = no-op
{
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Mora em São Paulo', pagina: 'perfil', linha_pagina: '- Mora em São Paulo' }];
  const { e, r } = rodar([{ op: 'definir', assunto: 'Cidade', valor: 'mora em são paulo' }], fatos, { perfil: '- Mora em São Paulo' });
  t('identical one is skipped', e.puladas[0] === 'definir:igual' && !Object.keys(r.paginas).length);
}
// fact line was edited by the owner = add instead of broken fix
{
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Mora em São Paulo', pagina: 'perfil', linha_pagina: '- Mora em São Paulo' }];
  const { r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Mora em Curitiba' }], fatos, { perfil: '- mora na capital paulista' });
  t('gone line becomes add', r.paginas.perfil === '- mora na capital paulista\n- Mora em Curitiba (antes: Mora em São Paulo)');
}
// changed page = remove from the old one + add to the new one
{
  const fatos = [{ id: 1, assunto: 'empresa', valor: 'Trabalha na Acme', pagina: 'perfil', linha_pagina: '- Trabalha na Acme' }];
  const { r } = rodar([{ op: 'definir', assunto: 'empresa', valor: 'Trabalha na Beta', pagina: 'trabalho' }], fatos,
    { perfil: '- Trabalha na Acme\n- gosta de café', trabalho: '' });
  t('comes out of the old one', r.paginas.perfil === '- gosta de café');
  t('goes into the new one', r.paginas.trabalho === '- Trabalha na Beta (antes: Trabalha na Acme)');
  t('internal remove carries the index', r.mudancas.every((m) => m.fato === 0));
}
// no explicit page = stays where it already was
{
  const fatos = [{ id: 1, assunto: 'camisa', valor: 'Veste camisa M', pagina: 'compras', linha_pagina: '- Veste camisa M' }];
  const { r } = rodar([{ op: 'definir', assunto: 'camisa', valor: 'Veste camisa G' }], fatos, { compras: '- Veste camisa M' });
  t('keeps the fact page', r.paginas.compras === '- Veste camisa G (antes: Veste camisa M)');
}
// ops antigas passam intactas e fix registra a linha anterior
{
  const { r } = rodar([{ op: 'fix', pagina: 'perfil', ancora: 'treina de manhã', texto: 'treina à noite' }], [], { perfil: '- treina de manhã' });
  t('legacy fix keeps the before value', r.mudancas[0].antes === '- treina de manhã' && r.mudancas[0].fato === undefined);
}
// validation
{
  const { e } = rodar([{ op: 'definir', assunto: '', valor: 'x y z w' }, { op: 'definir', assunto: 'a', valor: 'x' }], [], { perfil: '' });
  t('missing subject / short value', e.puladas.join(',') === 'definir:sem_assunto,definir:valor_curto');
}

// composite line (coming from the migration): swaps only the piece, preserves the rest
{
  const L = '- Nome: Ana Souza, e-mail ana@x.com, mora em Recife';
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Recife', pagina: 'perfil', linha_pagina: L }];
  const { r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Olinda' }], fatos, { perfil: `${L}\n- gosta de café` });
  t('composite swaps in place', r.paginas.perfil === '- Nome: Ana Souza, e-mail ana@x.com, mora em Olinda\n- gosta de café');
}
{
  const L = '- Recife hoje, antes Recife também';
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Recife', pagina: 'perfil', linha_pagina: L }];
  const { r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Mora em Olinda' }], fatos, { perfil: L });
  t('ambiguous composite becomes add without deleting', r.paginas.perfil === `${L}\n- Mora em Olinda (antes: Recife)`);
}
{
  const L = '- Nome: Ana, mora em Recife';
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Recife', pagina: 'perfil', linha_pagina: L }];
  const { r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Mora em Olinda', pagina: 'casa' }], fatos, { perfil: L, casa: '' });
  t('composite changing page does not remove the old one', r.paginas.perfil === undefined || r.paginas.perfil === L);
  t('composite changing page adds to the new one', r.paginas.casa === '- Mora em Olinda (antes: Recife)');
}
{
  const L = '- Nome: Ana, mora em Recife';
  const fatos = [{ id: 1, assunto: 'cidade', valor: 'Recife', pagina: 'perfil', linha_pagina: L }];
  const { e, r } = rodar([{ op: 'definir', assunto: 'cidade', valor: 'Recife', desde: '2024' }], fatos, { perfil: L });
  t('composite with only a new date does not touch anything', !e.ops.length && !Object.keys(r.paginas).length && e.definicoes[0].linha === L);
}
t('trocarNaLinha whole word', trocarNaLinha('- mora em Recifense', 'Recife', 'X') === null);
t('trocarNaLinha accent/uppercase', trocarNaLinha('- vive em SÃO PAULO', 'são paulo', 'Rio') === '- vive em Rio');

console.log(`${ok} ok, ${fail} falhas`);
if (fail) process.exit(1);
