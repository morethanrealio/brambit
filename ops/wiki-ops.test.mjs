// Tests for the memory operations (Phase 1/1-B/2). Pure: doesn't touch the database.
// Run: node ops/wiki-ops.test.mjs   (needs node_modules because of db.mjs)
import { aplicarOps, diffPerfil, tituloDe, filtrarEscritoNoTurno } from '../web/wiki.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; } else { fail++; console.log(`FALHOU: ${nome}`); } };

const P = (body) => ({ perfil: body });
// Counts the profile facts ignoring the links section (which is generated).
const fatosSemLinks = (body) => {
  const L = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
  const i = L.findIndex((l) => l.startsWith('## Mais detalhe'));
  return (i < 0 ? L : L.slice(0, i)).filter((l) => !l.startsWith('#')).length;
};
const base = '- mora em São Paulo\n- trabalha com produto\n- treina de manhã';

// ── add ──
{
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], P(base));
  t('add appends a line', r.paginas.perfil.split('\n').length === 4);
  t('add preserves the old ones', r.paginas.perfil.includes('mora em São Paulo'));
  t('add normalizes bullet', r.paginas.perfil.endsWith('- gosta de café coado'));
}
{
  // Dedup is by case and bullet (`norm` does NOT strip accents, so "Sao" != "São").
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'MORA EM SÃO PAULO' }], P(base));
  t('duplicate add (case/bullet) is skipped', !Object.keys(r.paginas).length && r.puladas[0] === 'add:duplicado');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'curto' }], P(base));
  t('short add is skipped', r.puladas[0] === 'add:texto_curto');
}

// ── fix ──
{
  const r = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'treina de manhã', texto: 'treina à noite' }], P(base));
  t('fix swaps only the anchor line', r.paginas.perfil === '- mora em São Paulo\n- trabalha com produto\n- treina à noite');
}
{
  const r = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'anda de bicicleta', texto: 'anda de moto' }], P(base));
  t('fix without anchor = no-op', !Object.keys(r.paginas).length && r.puladas[0] === 'fix:ancora_nao_encontrada');
}
{
  // EXACT match has priority; ambiguous is when the anchor only matches by substring
  // and matches more than one line.
  const dup = '- reunião com o time toda segunda\n- reunião com o time de vendas';
  const r = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'reunião com o time', texto: 'reunião só quinzenal' }], P(dup));
  t('ambiguous fix = no-op', !Object.keys(r.paginas).length && r.puladas[0] === 'fix:ancora_ambigua');
  const exato = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'reunião com o time de vendas', texto: 'reunião com vendas quinzenal' }], P(dup));
  t('fix matches exact even with a similar line next to it', exato.paginas.perfil === '- reunião com o time toda segunda\n- reunião com vendas quinzenal');
}

// ── remove (new in Phase 1-B) ──
{
  const r = aplicarOps([{ op: 'remove', pagina: 'perfil', ancora: 'trabalha com produto' }], P(base));
  t('remove deletes only the anchor line', r.paginas.perfil === '- mora em São Paulo\n- treina de manhã');
}
{
  const r = aplicarOps([{ op: 'remove', pagina: 'perfil', ancora: 'nunca escrito aqui' }], P(base));
  t('remove without anchor = no-op', !Object.keys(r.paginas).length && r.puladas[0] === 'remove:ancora_nao_encontrada');
}
{
  const r = aplicarOps([{ op: 'remove', pagina: 'perfil', ancora: 'curto' }], P(base));
  t('remove with short anchor = no-op', r.puladas[0] === 'remove:ancora_curta');
}

// ── move ──
{
  const r = aplicarOps([{ op: 'move', pagina: 'trabalho', ancora: 'trabalha com produto' }], P(base));
  t('move takes it out of the profile', !r.paginas.perfil.includes('trabalha com produto'));
  t('move puts it in the destination with literal text', r.paginas.trabalho === '- trabalha com produto');
}

// ── new page (the path the memoria_anotar tool uses) ──
{
  const r = aplicarOps([{ op: 'add', pagina: 'marcas', texto: 'usa tênis Nike 42' }], { marcas: '' });
  t('add creates the empty page given by the caller', r.paginas.marcas === '- usa tênis Nike 42');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'inventada-do-modelo', texto: 'qualquer coisa durável' }], P(base));
  t('unknown destination is skipped', r.puladas[0]?.startsWith('add:pagina_desconhecida'));
}

// ── operation ceiling ──
{
  const seis = Array.from({ length: 6 }, (_, i) => ({ op: 'add', pagina: 'perfil', texto: `fato numero ${i} aqui` }));
  const r = aplicarOps(seis, P(base));
  t('cap of 5 ops per call', r.feitas.length === 5);
}

// ── loss detector (guardrail for memoria_escrever) ──
{
  const condensado = '- mora em SP e trabalha com produto';
  const d = diffPerfil(base, condensado);
  t('condensing shows up as a loss', d.del >= 1);
}
{
  const acrescentado = `${base}\n- gosta de café coado`;
  const d = diffPerfil(base, acrescentado);
  t('adding does not count as a loss', d.del === 0 && d.add === 1);
}
{
  const editado = base.replace('treina de manhã', 'treina de manhã na academia');
  const d = diffPerfil(base, editado);
  t('editing a line counts as a change, not a loss', d.del === 0 && d.chg === 1);
}

// ── PHASE 2: profile ceiling, area/person pages, links section ──
{
  // Ceiling = 15 facts (PERFIL_MAX_LINHAS). When full: the new fact is NOT cut nor
  // discarded, it's routed to the overflow page.
  const cheio = Array.from({ length: 15 }, (_, i) => `- fato numero ${i} do perfil`).join('\n');
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], { perfil: cheio, notas: '' });
  t('profile at the cap routes to notes', r.paginas.notas === '- gosta de café coado');
  t('profile at the cap loses nothing', !r.paginas.perfil);
  t('routing shows up in the log', r.feitas[0] === 'add(notas) [perfil-cheio]');
}
{
  // Without the overflow page loaded, writing would overwrite unread content:
  // so it skips with a reason, instead of risking loss.
  const cheio = Array.from({ length: 20 }, (_, i) => `- fato numero ${i} do perfil`).join('\n');
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], { perfil: cheio });
  t('without the overflow loaded the add is skipped', !Object.keys(r.paginas).length && r.puladas[0] === 'add:perfil_cheio');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], P(base));
  t('profile below the cap keeps accepting', r.paginas.perfil.endsWith('- gosta de café coado'));
}
{
  // New fact goes in BEFORE the links section (which is generated, always stays at the end).
  const comLinks = `${base}\n\n## Mais detalhe (leia com memoria_ler quando a tarefa pedir)\n- trabalho — Trabalho`;
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], P(comLinks));
  const L = r.paginas.perfil.split('\n');
  t('add goes in before the links section', L[3] === '- gosta de café coado' && L[4] === '' && L[5].startsWith('## Mais detalhe'));
  t('links section does not count toward the cap', fatosSemLinks(r.paginas.perfil) === 4);
}
{
  // Patch write doesn't flatten the page: indentation and blank lines stay
  // (prod 2026-09-25: a hand-edited page lost its 23 sub-items on one add).
  const pag = '- Filhos\n  - Ana, 8 anos\n  - Bia, 5 anos\n\n- Escola\n  - Colégio X';
  const r = aplicarOps([{ op: 'add', pagina: 'pessoa-cadu', texto: 'Escola nova: Sarapiquá' }], { 'pessoa-cadu': pag });
  t('add preserves indentation and blank line', r.paginas['pessoa-cadu'] === pag + '\n- Escola nova: Sarapiquá');
  const f = aplicarOps([{ op: 'fix', pagina: 'pessoa-cadu', ancora: 'Bia, 5 anos', texto: 'Bia, 6 anos' }], { 'pessoa-cadu': pag });
  t('fix keeps the sub-item at the same level', f.paginas['pessoa-cadu'].split('\n')[2] === '  - Bia, 6 anos' && f.paginas['pessoa-cadu'].split('\n')[3] === '');
  const nada = aplicarOps([{ op: 'add', pagina: 'pessoa-cadu', texto: 'Ana, 8 anos' }], { 'pessoa-cadu': pag });
  t('indented duplicate is recognized', nada.puladas[0] === 'add:duplicado');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'pessoa-clara', texto: 'Clara é a sócia dele na Acme' }], P(base));
  t('per-person page is a valid destination', r.paginas['pessoa-clara'] === '- Clara é a sócia dele na Acme');
  t('person page title is the name', tituloDe('pessoa-clara') === 'Clara');
  t('area title comes from the catalog', tituloDe('comunicacao') === 'Como se comunica');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'pessoa-x', texto: 'qualquer coisa durável' }], P(base));
  t('person slug too short is skipped', r.puladas[0]?.startsWith('add:pagina_desconhecida'));
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'comunicacao', texto: 'prefere resposta curta e direta' }], P(base));
  t('new Phase 2 area is a valid destination', r.paginas.comunicacao === '- prefere resposta curta e direta');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'atualizacoes', texto: 'tentando escrever no log' }], P(base));
  t('updates page is reserved', !Object.keys(r.paginas).length && r.puladas[0] === 'add:pagina_reservada');
}
{
  // `mudancas` is what feeds the updates box (no model cost).
  const r = aplicarOps([
    { op: 'add', pagina: 'perfil', texto: 'gosta de café coado' },
    { op: 'fix', pagina: 'perfil', ancora: 'treina de manhã', texto: 'treina à noite' },
    { op: 'remove', pagina: 'perfil', ancora: 'trabalha com produto' },
  ], P(base));
  t('mudancas records the 3 operations', r.mudancas.length === 3);
  t('mudancas brings op/pagina/texto', r.mudancas[0].op === 'add' && r.mudancas[0].pagina === 'perfil' && r.mudancas[0].texto === 'gosta de café coado');
  t('mudancas from remove keeps the deleted line', r.mudancas[2].texto.includes('trabalha com produto'));
}
{
  const r = aplicarOps([{ op: 'nada' }], P(base));
  t('nothing does not register a change', !r.mudancas.length && !Object.keys(r.paginas).length);
}

// ── housekeeping doesn't overwrite what the tool wrote in the same turn ──
{
  // Prod 25/09: tool recorded R$619, housekeeping swapped it for R$522 3s later.
  const fatos = [
    { assunto: 'preco_do_voo', linha_pagina: '- Preço do voo: R$619', fonte: { origem: 'memoria_anotar', turn_id: 'T1' } },
    { assunto: 'cidade', linha_pagina: '- Mora em Curitiba', fonte: { origem: 'housekeeping', turn_id: 'T0' } },
  ];
  const ops = [
    { op: 'definir', assunto: 'Preço do voo', valor: 'R$522' },
    { op: 'fix', ancora: 'Preço do voo: R$619', texto: 'Preço do voo: R$522' },
    { op: 'definir', assunto: 'cidade', valor: 'Londrina' },
  ];
  const r = filtrarEscritoNoTurno(ops, fatos, 'housekeeping', 'T1');
  t('housekeeping does not touch the fact from the tool in the same turn', r.ops.length === 1 && r.ops[0].assunto === 'cidade' && r.puladas.length === 2);
  t('different turn stays free', filtrarEscritoNoTurno(ops, fatos, 'housekeeping', 'T2').ops.length === 3);
  t('the tool itself is not blocked', filtrarEscritoNoTurno(ops, fatos, 'memoria_anotar', 'T1').ops.length === 3);
}

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
