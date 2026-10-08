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
  t('add acrescenta linha', r.paginas.perfil.split('\n').length === 4);
  t('add preserva as antigas', r.paginas.perfil.includes('mora em São Paulo'));
  t('add normaliza bullet', r.paginas.perfil.endsWith('- gosta de café coado'));
}
{
  // Dedup is by case and bullet (`norm` does NOT strip accents, so "Sao" != "São").
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'MORA EM SÃO PAULO' }], P(base));
  t('add duplicado (caixa/bullet) é pulado', !Object.keys(r.paginas).length && r.puladas[0] === 'add:duplicado');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'curto' }], P(base));
  t('add curto é pulado', r.puladas[0] === 'add:texto_curto');
}

// ── fix ──
{
  const r = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'treina de manhã', texto: 'treina à noite' }], P(base));
  t('fix troca só a linha da âncora', r.paginas.perfil === '- mora em São Paulo\n- trabalha com produto\n- treina à noite');
}
{
  const r = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'anda de bicicleta', texto: 'anda de moto' }], P(base));
  t('fix sem âncora = no-op', !Object.keys(r.paginas).length && r.puladas[0] === 'fix:ancora_nao_encontrada');
}
{
  // EXACT match has priority; ambiguous is when the anchor only matches by substring
  // and matches more than one line.
  const dup = '- reunião com o time toda segunda\n- reunião com o time de vendas';
  const r = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'reunião com o time', texto: 'reunião só quinzenal' }], P(dup));
  t('fix ambíguo = no-op', !Object.keys(r.paginas).length && r.puladas[0] === 'fix:ancora_ambigua');
  const exato = aplicarOps([{ op: 'fix', pagina: 'perfil', ancora: 'reunião com o time de vendas', texto: 'reunião com vendas quinzenal' }], P(dup));
  t('fix casa exato mesmo com linha parecida ao lado', exato.paginas.perfil === '- reunião com o time toda segunda\n- reunião com vendas quinzenal');
}

// ── remove (new in Phase 1-B) ──
{
  const r = aplicarOps([{ op: 'remove', pagina: 'perfil', ancora: 'trabalha com produto' }], P(base));
  t('remove apaga só a linha da âncora', r.paginas.perfil === '- mora em São Paulo\n- treina de manhã');
}
{
  const r = aplicarOps([{ op: 'remove', pagina: 'perfil', ancora: 'nunca escrito aqui' }], P(base));
  t('remove sem âncora = no-op', !Object.keys(r.paginas).length && r.puladas[0] === 'remove:ancora_nao_encontrada');
}
{
  const r = aplicarOps([{ op: 'remove', pagina: 'perfil', ancora: 'curto' }], P(base));
  t('remove com âncora curta = no-op', r.puladas[0] === 'remove:ancora_curta');
}

// ── move ──
{
  const r = aplicarOps([{ op: 'move', pagina: 'trabalho', ancora: 'trabalha com produto' }], P(base));
  t('move tira do perfil', !r.paginas.perfil.includes('trabalha com produto'));
  t('move põe no destino com texto literal', r.paginas.trabalho === '- trabalha com produto');
}

// ── new page (the path the memoria_anotar tool uses) ──
{
  const r = aplicarOps([{ op: 'add', pagina: 'marcas', texto: 'usa tênis Nike 42' }], { marcas: '' });
  t('add cria página vazia informada pelo chamador', r.paginas.marcas === '- usa tênis Nike 42');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'inventada-do-modelo', texto: 'qualquer coisa durável' }], P(base));
  t('destino desconhecido é pulado', r.puladas[0]?.startsWith('add:pagina_desconhecida'));
}

// ── operation ceiling ──
{
  const seis = Array.from({ length: 6 }, (_, i) => ({ op: 'add', pagina: 'perfil', texto: `fato numero ${i} aqui` }));
  const r = aplicarOps(seis, P(base));
  t('teto de 5 ops por chamada', r.feitas.length === 5);
}

// ── loss detector (guardrail for memoria_escrever) ──
{
  const condensado = '- mora em SP e trabalha com produto';
  const d = diffPerfil(base, condensado);
  t('condensar aparece como perda', d.del >= 1);
}
{
  const acrescentado = `${base}\n- gosta de café coado`;
  const d = diffPerfil(base, acrescentado);
  t('acrescentar não conta como perda', d.del === 0 && d.add === 1);
}
{
  const editado = base.replace('treina de manhã', 'treina de manhã na academia');
  const d = diffPerfil(base, editado);
  t('editar linha conta como mudança, não perda', d.del === 0 && d.chg === 1);
}

// ── PHASE 2: profile ceiling, area/person pages, links section ──
{
  // Ceiling = 15 facts (PERFIL_MAX_LINHAS). When full: the new fact is NOT cut nor
  // discarded, it's routed to the overflow page.
  const cheio = Array.from({ length: 15 }, (_, i) => `- fato numero ${i} do perfil`).join('\n');
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], { perfil: cheio, notas: '' });
  t('perfil no teto roteia pra notas', r.paginas.notas === '- gosta de café coado');
  t('perfil no teto não perde nada', !r.paginas.perfil);
  t('roteamento aparece no log', r.feitas[0] === 'add(notas) [perfil-cheio]');
}
{
  // Without the overflow page loaded, writing would overwrite unread content:
  // so it skips with a reason, instead of risking loss.
  const cheio = Array.from({ length: 20 }, (_, i) => `- fato numero ${i} do perfil`).join('\n');
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], { perfil: cheio });
  t('sem overflow carregado o add é pulado', !Object.keys(r.paginas).length && r.puladas[0] === 'add:perfil_cheio');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], P(base));
  t('perfil abaixo do teto segue aceitando', r.paginas.perfil.endsWith('- gosta de café coado'));
}
{
  // New fact goes in BEFORE the links section (which is generated, always stays at the end).
  const comLinks = `${base}\n\n## Mais detalhe (leia com memoria_ler quando a tarefa pedir)\n- trabalho — Trabalho`;
  const r = aplicarOps([{ op: 'add', pagina: 'perfil', texto: 'gosta de café coado' }], P(comLinks));
  const L = r.paginas.perfil.split('\n');
  t('add entra antes da seção de links', L[3] === '- gosta de café coado' && L[4] === '' && L[5].startsWith('## Mais detalhe'));
  t('seção de links não conta pro teto', fatosSemLinks(r.paginas.perfil) === 4);
}
{
  // Patch write doesn't flatten the page: indentation and blank lines stay
  // (prod 2026-09-25: a hand-edited page lost its 23 sub-items on one add).
  const pag = '- Filhos\n  - Ana, 8 anos\n  - Bia, 5 anos\n\n- Escola\n  - Colégio X';
  const r = aplicarOps([{ op: 'add', pagina: 'pessoa-cadu', texto: 'Escola nova: Sarapiquá' }], { 'pessoa-cadu': pag });
  t('add preserva recuo e linha em branco', r.paginas['pessoa-cadu'] === pag + '\n- Escola nova: Sarapiquá');
  const f = aplicarOps([{ op: 'fix', pagina: 'pessoa-cadu', ancora: 'Bia, 5 anos', texto: 'Bia, 6 anos' }], { 'pessoa-cadu': pag });
  t('fix mantém o subitem no mesmo nível', f.paginas['pessoa-cadu'].split('\n')[2] === '  - Bia, 6 anos' && f.paginas['pessoa-cadu'].split('\n')[3] === '');
  const nada = aplicarOps([{ op: 'add', pagina: 'pessoa-cadu', texto: 'Ana, 8 anos' }], { 'pessoa-cadu': pag });
  t('duplicado com recuo é reconhecido', nada.puladas[0] === 'add:duplicado');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'pessoa-clara', texto: 'Clara é a sócia dele na Acme' }], P(base));
  t('página por pessoa é destino válido', r.paginas['pessoa-clara'] === '- Clara é a sócia dele na Acme');
  t('título da página de pessoa é o nome', tituloDe('pessoa-clara') === 'Clara');
  t('título de área vem do catálogo', tituloDe('comunicacao') === 'Como se comunica');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'pessoa-x', texto: 'qualquer coisa durável' }], P(base));
  t('slug de pessoa curto demais é pulado', r.puladas[0]?.startsWith('add:pagina_desconhecida'));
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'comunicacao', texto: 'prefere resposta curta e direta' }], P(base));
  t('área nova da Fase 2 é destino válido', r.paginas.comunicacao === '- prefere resposta curta e direta');
}
{
  const r = aplicarOps([{ op: 'add', pagina: 'atualizacoes', texto: 'tentando escrever no log' }], P(base));
  t('página de atualizações é reservada', !Object.keys(r.paginas).length && r.puladas[0] === 'add:pagina_reservada');
}
{
  // `mudancas` is what feeds the updates box (no model cost).
  const r = aplicarOps([
    { op: 'add', pagina: 'perfil', texto: 'gosta de café coado' },
    { op: 'fix', pagina: 'perfil', ancora: 'treina de manhã', texto: 'treina à noite' },
    { op: 'remove', pagina: 'perfil', ancora: 'trabalha com produto' },
  ], P(base));
  t('mudancas registra as 3 operações', r.mudancas.length === 3);
  t('mudancas traz op/pagina/texto', r.mudancas[0].op === 'add' && r.mudancas[0].pagina === 'perfil' && r.mudancas[0].texto === 'gosta de café coado');
  t('mudancas do remove guarda a linha apagada', r.mudancas[2].texto.includes('trabalha com produto'));
}
{
  const r = aplicarOps([{ op: 'nada' }], P(base));
  t('nada não registra mudança', !r.mudancas.length && !Object.keys(r.paginas).length);
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
  t('housekeeping não mexe no fato da tool do mesmo turno', r.ops.length === 1 && r.ops[0].assunto === 'cidade' && r.puladas.length === 2);
  t('outro turno segue livre', filtrarEscritoNoTurno(ops, fatos, 'housekeeping', 'T2').ops.length === 3);
  t('a própria tool não é bloqueada', filtrarEscritoNoTurno(ops, fatos, 'memoria_anotar', 'T1').ops.length === 3);
}

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
