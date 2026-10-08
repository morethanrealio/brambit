// ── Per-user memory wiki (Karpathy model) ──
// Markdown pages the agent reads/writes, SHARED across all Claws
// of the same person (the "user" layer). Lives in Postgres (multi-tenant, not in a
// loose file). Exposes file-like tools in the tool loop + injects an index + the
// `perfil` page into the system prompt. See projetos/arquitetura-memoria.md.

import { listWikiPages, listWikiPagesFull, getWikiPage, upsertWikiPage, searchWikiPages, normWikiSlug, listCurrentFacts, listAllFacts, setFact, closeFact, updateFactLine, addHistorico, listMemoryAmbiguities, getMemoryAmbiguity, closeMemoryAmbiguity, reopenMemoryAmbiguity, revertFactSwap, getUserTimezone } from './db.mjs';
import { makeMemoriaModel } from './memoria-modelo.mjs';
import { tagIdioma, defaultTimezone } from './locale.mjs';
import { buscaV2Ligada, buscarNaMemoria, formatarAchados } from './memoria-busca.mjs';
import { reconciliarLigado, planejarOp } from './wiki-reconciliar.mjs';

// Always-injected page: the short and stable "who you are" (successor to the flat profile).
const PERFIL = 'perfil';

// ── PHASE 2: perfil = short OVERVIEW linking to the areas ──
// Format inspired by what Town does: the main page is a summary with links to
// the area pages, each topic has its own page, and there is a log of what
// changed. Invariant of this phase: NOTHING is deleted and NOTHING is
// truncated. The profile cap doesn't cut lines: it ROUTES the new fact to an
// area page. What is already written only moves in Phase 4, with a dry run.
const AREAS = {
  // facets (the cut by FUNCTION that Town uses)
  comunicacao: 'Como se comunica',
  preferencias: 'Preferências',
  background: 'Background profissional',
  rotina: 'Padrões e rotina',
  rede: 'Rede pessoal e profissional',
  objetivos: 'Objetivos',
  projetos: 'Projetos',
  notas: 'Notas',
  // subject pages that already existed before Phase 2 (still apply)
  pessoas: 'Pessoas',
  trabalho: 'Trabalho',
  saude: 'Saúde',
  alimentacao: 'Alimentação',
  treinos: 'Treinos',
  financas: 'Finanças',
  casa: 'Casa',
  compras: 'Compras',
};
const OVERFLOW = 'notas';            // where the fact falls when the profile is at the cap
// R4 (flag MEMORIA_HISTORICO=1): no line leaves the page without leaving the old
// version in the history (closed memory_facts), including a line that isn't a fact.
export const historicoLigado = () => process.env.MEMORIA_HISTORICO === '1';
const ATUALIZACOES = 'atualizacoes'; // record of what changed; maintained only by the server
const MARCA_LINKS = '## Mais detalhe';
const CAB_ATUALIZACOES = 'O que mudou na sua memória (mais recente primeiro). Página mantida automaticamente.';
const MAX_ATUALIZACOES = 60;
// Cap of FACTS in the profile (the rest becomes a link). Overridable without a deploy.
const PERFIL_MAX = Math.max(5, Number(process.env.PERFIL_MAX_LINHAS || 15));

// One page per person (`pessoa-ana`), instead of a line in a `pessoas` page.
const ehPaginaDePessoa = (slug) => /^pessoa-[a-z0-9-]{2,}$/.test(slug);

export function tituloDe(slug) {
  if (slug === PERFIL) return 'Perfil';
  if (slug === ATUALIZACOES) return 'Atualizações recentes';
  if (AREAS[slug]) return AREAS[slug];
  if (ehPaginaDePessoa(slug)) {
    return slug.slice('pessoa-'.length).split('-').filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return slug;
}

// Builds the wiki tools for THIS user (enter the registry per request).
export function wikiTools(userId, { fonte = {} } = {}) {
  return [
    {
      name: 'memoria_listar',
      description: 'Lists the pages of your long-term memory about the user (slug + title). Use it to know what you have already noted before answering.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const pages = await listWikiPages(userId);
        return pages.length ? JSON.stringify(pages.map((p) => ({ slug: p.slug, title: p.title }))) : 'Memória vazia ainda.';
      },
    },
    {
      name: 'memoria_ler',
      description: 'Reads the content of a memory page by slug (obtained from memoria_listar).',
      parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      async run({ slug }) {
        const p = await getWikiPage(userId, slug);
        return p ? p.body : `Não existe página "${slug}".`;
      },
    },
    {
      name: 'memoria_buscar',
      description: buscaV2Ligada()
        ? 'Searches the user\'s memory (pages and facts, including the history of what is no longer valid). Accepts several words, with no need for accents or the exact form; returns the most relevant lines with the page they are on.'
        : 'Searches for a term in the user\'s memory pages. Returns pages with a context snippet.',
      parameters: { type: 'object', properties: { termo: { type: 'string' } }, required: ['termo'] },
      async run({ termo }) {
        if (buscaV2Ligada()) {
          const [full, fatos] = await Promise.all([listWikiPagesFull(userId), listAllFacts(userId).catch(() => [])]);
          return formatarAchados(buscarNaMemoria(Object.fromEntries(full.map((p) => [p.slug, p])), fatos, termo));
        }
        const hits = await searchWikiPages(userId, termo);
        return hits.length ? JSON.stringify(hits) : 'Nada encontrado na memória.';
      },
    },
    {
      name: 'memoria_anotar', keepsStepText: true,
      description: 'Stores, corrects or removes FACTS in long-term memory about the USER (preferences, context, people, decisions), one fact per operation, WITHOUT rewriting the page. It is the default path for memory: use this to add to or fix what is already noted. Do NOT use it for small talk or ephemeral data.',
      parameters: {
        type: 'object',
        properties: {
          pagina: {
            type: 'string',
            description: 'Slug of the target page. "perfil" is the BIG SUMMARY (only what defines the person and applies to almost every conversation; it has a cap). Detail goes to an area page: '
              + Object.keys(AREAS).join(', ') + '. Specific person = one page per person, in the format "pessoa-nome" (e.g. "pessoa-ana"). Default: "perfil".',
          },
          add: { type: 'array', items: { type: 'string' }, description: 'NEW facts, one per item, one short line each.' },
          corrigir: {
            type: 'array',
            description: 'Corrections of an already-noted fact (use when the new information CONTRADICTS the old one).',
            items: {
              type: 'object',
              properties: {
                ancora: { type: 'string', description: 'LITERAL excerpt of a line that already exists on the page.' },
                texto: { type: 'string', description: 'The corrected line, in full.' },
              },
              required: ['ancora', 'texto'],
            },
          },
          remover: { type: 'array', items: { type: 'string' }, description: 'Literal excerpt of the lines to delete (only when the owner asks).' },
        },
      },
      async run({ pagina, add, corrigir, remover }) {
        const slug = normWikiSlug(pagina || PERFIL);
        const ops = [
          ...(Array.isArray(add) ? add : []).map((texto) => ({ op: 'add', pagina: slug, texto })),
          ...(Array.isArray(corrigir) ? corrigir : []).map((c) => ({ op: 'fix', pagina: slug, ancora: c?.ancora, texto: c?.texto })),
          ...(Array.isArray(remover) ? remover : []).map((ancora) => ({ op: 'remove', pagina: slug, ancora })),
        ];
        if (!ops.length) return 'Nada pra anotar: mande add, corrigir ou remover.';
        const atual = await getWikiPage(userId, slug);
        // The slug key enters the map even empty: this way `aplicarOps` accepts the
        // destination and the page is CREATED on the first `add`, without needing another tool.
        const antesPor = { [slug]: atual?.body || '' };
        // If the destination is the profile, also loads the overflow page: the profile's
        // cap ROUTES the fact there, and writing without having read it would erase what was there.
        if (slug === PERFIL) antesPor[OVERFLOW] = (await getWikiPage(userId, OVERFLOW))?.body || '';
        const res = await escreverComFatos(userId, ops, {
          paginas: antesPor, titulos: atual?.title ? { [slug]: atual.title } : {},
          fonte: { ...fonte, origem: 'memoria_anotar' }, origem: 'conversa', logTag: 'tool=memoria_anotar',
        });
        if (!res.feitas.length && res.puladas.length && res.puladas.every((x) => x.includes(':ja_existe('))) {
          return `Já estava anotado (${res.puladas.join(', ')}). Nada a gravar.`;
        }
        if (!res.feitas.length) {
          // VISIBLE failure (anchor that doesn't match, short text, duplicate): the model
          // gets the reason and can try again, instead of thinking it saved.
          return `Nada gravado (${res.puladas.join(', ') || 'nenhuma operação válida'}). Se a âncora não casou, leia a página com memoria_ler e use um trecho literal.`;
        }
        return `Memória atualizada: ${res.feitas.join(', ')}${res.puladas.length ? ` | puladas: ${res.puladas.join(', ')}` : ''}`;
      },
    },
    {
      name: 'memoria_atualizar',
      description: 'Stores or UPDATES a fact that has ONE current value and can change over time (where they live, company, job title, clothing size, main goal, health plan...), identified by a stable KEY (assunto). If a fact with that key already exists, the old one leaves the page and goes to the history, instead of both coexisting. Prefer this over memoria_anotar whenever the new information REPLACES an old one. Reuse EXACTLY the key that already appears in the context\'s list of facts.',
      parameters: {
        type: 'object',
        properties: {
          assunto: { type: 'string', description: 'Short, stable key for the subject, in snake_case, e.g. "cidade_onde_mora", "empresa_atual", "tamanho_camisa".' },
          valor: { type: 'string', description: 'The current fact, one short self-explanatory line (e.g. "Mora em Curitiba").' },
          pagina: { type: 'string', description: 'Page where the line goes. Default: the page where the fact already is, or "perfil".' },
          desde: { type: 'string', description: 'Optional, ONLY if the person said when: YYYY-MM-DD, YYYY-MM or YYYY.' },
        },
        required: ['assunto', 'valor'],
      },
      async run({ assunto, valor, pagina, desde }) {
        const titulos = Object.fromEntries((await listWikiPages(userId)).map((p) => [p.slug, p.title]));
        const res = await escreverComFatos(userId, [{ op: 'definir', assunto, valor, pagina, desde }], {
          paginas: {}, titulos, fonte: { ...fonte, origem: 'memoria_atualizar' }, origem: 'conversa',
          logTag: 'tool=memoria_atualizar', criarPagina: true,
        });
        if (!res.fatos.length && res.puladas.some((x) => x.includes(':ja_existe('))) return `Já estava anotado (${res.puladas.join(', ')}).`;
        if (!res.fatos.length) return `Nada gravado (${res.puladas.join(', ') || 'nenhuma operação válida'}).`;
        return `Memória atualizada: ${res.feitas.join(', ')} [${res.fatos.join(', ')}]`;
      },
    },
    {
      name: 'memoria_resolver_duvida',
      description: 'Records the OWNER\'s answer to a "dúvida na memória" (a subject where memory has contradicting versions, listed in the context). Use ONLY after the owner has answered. If they confirmed one of the listed versions, send opcao with its id; if they gave a new value, send valor; if they said none matters anymore, descartar=true.',
      parameters: {
        type: 'object',
        properties: {
          assunto: { type: 'string', description: 'The key of the open question, exactly as it appears in the context.' },
          opcao: { type: 'string', description: 'Id of the version the owner confirmed (e.g. "casa:25").' },
          valor: { type: 'string', description: 'The correct value in the owner\'s words, one short line, when it is none of the versions.' },
          descartar: { type: 'boolean', description: 'true if the owner said the subject no longer matters.' },
        },
        required: ['assunto'],
      },
      async run({ assunto, opcao, valor, descartar }) {
        const abertas = await listMemoryAmbiguities({ userId });
        const d = abertas.find((x) => x.assunto === normAssunto(assunto));
        if (!d) return `Não há dúvida aberta com a chave "${assunto}".`;
        const r = await resolverDuvida(userId, d.id, { opcao, valor, descartar, por: 'dono', fonte });
        return r.ok ? `Dúvida resolvida: ${r.resolucao}` : `Não resolvi: ${r.erro}`;
      },
    },
    {
      name: 'memoria_escrever',
      description: 'Creates a NEW memory page, or rewrites an existing one when the OWNER explicitly asked to reorganize/redo it. To just add or correct a fact, use memoria_anotar (do not rewrite the page because of a new fact).',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Short page identifier, e.g. "perfil", "marcas", "tamanhos".' },
          titulo: { type: 'string', description: 'Human-readable page title.' },
          conteudo: { type: 'string', description: 'Body in markdown (the whole page).' },
          substituir: { type: 'boolean', description: 'true ONLY when the owner asked to rewrite/reorganize/delete content of this page.' },
        },
        required: ['slug', 'conteudo'],
      },
      async run({ slug, titulo, conteudo, substituir = false }) {
        if (normWikiSlug(slug || PERFIL) === ATUALIZACOES) {
          return `A página "${ATUALIZACOES}" é mantida automaticamente pelo servidor (registro do que mudou). Escreva na página do assunto.`;
        }
        const atual = await getWikiPage(userId, slug);
        const antes = atual?.body || '';
        // Deterministic guardrail: the rewrite only goes through if it does NOT lose a fact.
        // The A/B test from 2026-09-01 showed the two kinds of damage (condensing and mutating) and
        // both show up here as a line that leaves without a pair. An empty page (creation)
        // and an explicit owner request (replace) remain unrestricted.
        if (antes.trim() && !substituir) {
          const d = diffPerfil(antes, conteudo);
          if (d.del > 0) {
            return `Recusado: essa reescrita apagaria ${d.del} linha(s) da página "${slug}". Pra acrescentar ou corrigir um fato use memoria_anotar. Se o dono pediu pra reescrever/limpar a página, chame de novo com substituir=true.`;
          }
        }
        const s = await upsertWikiPage(userId, { slug, title: titulo || atual?.title || tituloDe(slug), body: conteudo });
        logDiffPerfil(userId, slug, antes, conteudo, `tool=memoria_escrever${substituir ? ' substituir' : ''}`);
        await posEscrita(userId, [{ op: 'write', pagina: s, texto: antes.trim() ? 'página reescrita a pedido do dono' : 'página criada' }], 'conversa');
        return `Página "${s}" salva.`;
      },
    },
  ];
}

// Text for the system prompt: the `perfil` page in full + index of the other pages.
// Since Phase 2 the profile itself already carries the (generated) links section, so here
// only the pages that fell OUTSIDE that section are included, so as not to pay for the index twice.
export async function wikiContext(userId, owner) {
  const pages = await listWikiPages(userId);
  if (!pages.length) return '';
  const lines = [];
  const corpo = ((await getWikiPage(userId, PERFIL))?.body || '').trim();
  if (corpo) {
    lines.push(
      `O que você já sabe sobre ${owner} (use pra personalizar, sem repetir de volta como papagaio):`,
      corpo,
    );
  }
  const outras = pages.filter((p) => p.slug !== PERFIL && p.slug !== ATUALIZACOES && !corpo.includes(`- ${p.slug} —`));
  if (outras.length) {
    lines.push(
      '',
      'Outras páginas da sua memória (leia com memoria_ler quando forem úteis pra tarefa):',
      ...outras.map((p) => `• ${p.slug} — ${p.title}`),
    );
  }
  // Keys of the current facts: without them the assistant invents a new key for the
  // same subject and the old fact is never replaced.
  // R2 (MEMORIA_BUSCA_V2=1): all keys, not just the 40 newest; an old fact
  // outside the list used to get rewritten with a new key.
  const fatos = await listCurrentFacts(userId, { limit: buscaV2Ligada() ? 400 : 40 }).catch(() => []);
  if (fatos.length) {
    lines.push(
      '',
      'Fatos com chave (quando um deles MUDAR, use memoria_atualizar com a MESMA chave):',
      // A long value is cut with "…" and the pointer to the page: without the mark the model
      // took the chunk as the whole value (a dissertation title came out truncated in the 2026-09-23 test).
      ...fatos.map((f) => { const v = String(f.valor); return `• ${f.assunto} [${f.pagina}]: ${v.length > 80 ? v.slice(0, 80) + `… (completo em ${f.pagina})` : v}`; }),
    );
  }
  // Open questions: all listed (the model needs to know which subject is uncertain),
  // but it only asks when the task at hand depends on that fact.
  const duvidas = await listMemoryAmbiguities({ userId, limit: 20 }).catch(() => []);
  if (duvidas.length) {
    lines.push(
      '',
      'Dúvidas na memória (versões que se contradizem). NÃO use nenhuma delas como certa. NUNCA puxe o assunto por conta própria nem pergunte sem contexto. Só pergunte ao dono qual vale quando o que ele pediu AGORA depende desse fato (ex.: ele pede algo que precisa do destino da mudança e a memória tem dois destinos); aí pergunte junto da resposta, em uma frase. Se o pedido não depende do fato, ignore a dúvida. Com a resposta, chame memoria_resolver_duvida:',
      ...duvidas.map((d) => `• ${d.assunto}: ${(d.opcoes || []).map((o) => `[${o.id}] ${String(o.txt).replace(/^\s*[-*•]\s*/, '').slice(0, 140)}`).join(' | ')}`),
    );
  }
  return lines.join('\n');
}

// ── PHASE 0: line-by-line loss detector ──
// Every housekeeping run compares the page BEFORE and AFTER and logs how many lines
// came in, went out and changed. Exists because the two error classes measured in the
// 2026-09-01 A/B test (gemini MUTATES a fact, V4 Flash CONDENSES and eats lines) are
// invisible in the result: the page stays plausible, just smaller. Without this counter,
// any change to the memory operation is a matter of faith.
// Line content only goes into the log with PERFIL_DIFF_VERBOSE=1 (the profile is personal
// data; the default logs only the numbers).
const norm = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const linhasDe = (txt) => String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean);
// Lines as they are on the page (indentation and blank lines preserved), just without
// trailing whitespace and without a leftover blank line at the end. This is what patch
// writing edits: with linhasDe, any op on a page used to flatten subitems and merge
// blocks (seen in prod on 2026-09-25 on a page edited by hand on the site).
const linhasCruas = (txt) => {
  const L = String(txt || '').split('\n').map((l) => l.trimEnd());
  while (L.length && !L[L.length - 1]) L.pop();
  return L;
};
const recuoDe = (l) => String(l || '').match(/^\s*/)[0];

// Word-based similarity (Jaccard). Used to tell "changed" apart from "left+entered":
// a rewritten line matches strongly with the one that left; a lost line matches nothing.
// Counts ALL words (including short ones): without them, a short edited line
// ("trains A and B at the gym" -> "...at the park") used to fall below the cutoff and became
// a false "lost". The error that matters not to let through is the LOSS, so the
// tie-break favors reporting too much, never too little.
function parecido(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function diffPerfil(antes, depois) {
  const a = linhasDe(antes), d = linhasDe(depois);
  const setA = new Map(a.map((l) => [norm(l), l]));
  const setD = new Map(d.map((l) => [norm(l), l]));
  const saiu = a.filter((l) => !setD.has(norm(l)));
  const entrou = d.filter((l) => !setA.has(norm(l)));
  // Matches each line that left with the best candidate that entered: a strong pair = an edit.
  const mudou = [], perdeu = [], usados = new Set();
  for (const s of saiu) {
    let best = -1, score = 0;
    entrou.forEach((e, i) => {
      if (usados.has(i)) return;
      const sc = parecido(s, e);
      if (sc > score) { score = sc; best = i; }
    });
    if (best >= 0 && score >= 0.5) { usados.add(best); mudou.push([s, entrou[best]]); }
    else perdeu.push(s);
  }
  const ganhou = entrou.filter((_, i) => !usados.has(i));
  return {
    linhas: d.length, linhasAntes: a.length,
    chars: String(depois || '').length, charsAntes: String(antes || '').length,
    add: ganhou.length, del: perdeu.length, chg: mudou.length,
    perdidas: perdeu, mudadas: mudou,
  };
}

export function logDiffPerfil(userId, slug, antes, depois, extra = '') {
  const d = diffPerfil(antes, depois);
  if (!d.add && !d.del && !d.chg) return d;
  const tag = `[perfil diff] u=${String(userId).slice(0, 8)} ${slug} +${d.add} -${d.del} ~${d.chg}` +
    ` linhas=${d.linhasAntes}->${d.linhas} chars=${d.charsAntes}->${d.chars}${extra ? ' ' + extra : ''}`;
  console.log(tag);
  if (process.env.PERFIL_DIFF_VERBOSE === '1') {
    for (const l of d.perdidas.slice(0, 5)) console.log(`  [perfil PERDEU] ${l.slice(0, 160)}`);
    for (const [s, e] of d.mudadas.slice(0, 5)) console.log(`  [perfil MUDOU] ${s.slice(0, 90)} => ${e.slice(0, 90)}`);
  }
  return d;
}

// ── PHASE 1: PATCH-based writing ──
// Housekeeping no longer asks for the page text: it asks for a LIST OF OPERATIONS and the
// server applies them deterministically. This way condensing/mutating becomes
// impossible by construction (the old text never passes through the model to come back).
// An anchor that doesn't match (or matches two lines) = NO-OP + log, never a partial write.
const MAX_OPS = 5;            // teto por ciclo: perfil muda devagar
const CANONICAS = Object.keys(AREAS);

// The profile's links section is GENERATED (see sincronizarLinks): a new fact goes in
// BEFORE it, and it doesn't count toward the cap.
const iMarca = (L) => L.findIndex((l) => String(l).trimStart().startsWith(MARCA_LINKS));
// EXACT format of the lines sincronizarLinks generates ("- slug — Title"). Used
// to separate the generated block from what the owner wrote below it.
const EH_LINK_GERADO = /^-\s+[a-z0-9-]+\s+—\s+\S/;
const fatosDe = (L) => { const i = iMarca(L); return (i < 0 ? L : L.slice(0, i)).filter((l) => String(l).trim() && !String(l).trimStart().startsWith('#')); };
// Before the links section (and the blank lines that separate it from the facts).
const inserirFato = (L, linha) => {
  let i = iMarca(L);
  if (i < 0) { L.push(linha); return; }
  while (i > 0 && !String(L[i - 1]).trim()) i--;
  L.splice(i, 0, linha);
};

// Finds the ONLY line that the anchor identifies. Returns {i} or {erro}.
function acharAncora(linhas, ancora) {
  const alvo = norm(ancora);
  if (alvo.length < 8) return { erro: 'ancora_curta' };
  // A blank line (empty norm) is never a target: "".includes would match everything.
  const ns = linhas.map((l, i) => [norm(l), i]).filter(([n]) => n);
  let hits = ns.filter(([n]) => n === alvo).map(([, i]) => i);
  if (!hits.length) hits = ns.filter(([n]) => n.includes(alvo) || alvo.includes(n)).map(([, i]) => i);
  if (!hits.length) return { erro: 'ancora_nao_encontrada' };
  if (hits.length > 1) return { erro: 'ancora_ambigua' };
  return { i: hits[0] };
}

// Applies the operations. Pure (doesn't touch the database): returns the pages to save + the log.
export function aplicarOps(ops, paginas, { maxOps = MAX_OPS } = {}) {
  const out = new Map();  // slug -> array of lines
  const linhasDoSlug = (slug) => {
    if (!out.has(slug)) out.set(slug, linhasCruas(paginas[slug] ?? ''));
    return out.get(slug);
  };
  const feitas = [], puladas = [], mudancas = [];
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, maxOps)) {
    // `fato` = index of the definition (op definir) that generated this op; whoever saves
    // the fact uses it to know where the line ended up.
    const tag = { ...(op?._fato != null ? { fato: op._fato } : {}), ...(op?._de ? { de: op._de } : {}) };
    const tipo = String(op?.op || '').toLowerCase();
    // Canonical name (same function the database uses to save). With two different
    // rules, "pessoa-joão" used to be read from one page and saved to another, and the
    // existing page came back with only the new line (finding #18).
    let destino = normWikiSlug(op?.pagina || PERFIL);
    const existe = destino === PERFIL || Object.prototype.hasOwnProperty.call(paginas, destino)
      || CANONICAS.includes(destino) || ehPaginaDePessoa(destino);
    if (tipo === 'nada' || !tipo) { continue; }
    if (destino === ATUALIZACOES) { puladas.push(`${tipo}:pagina_reservada`); continue; }
    if (!existe) { puladas.push(`${tipo}:pagina_desconhecida(${destino})`); continue; }
    if (tipo === 'add') {
      const texto = String(op?.texto || '').replace(/\s+/g, ' ').trim();
      if (texto.length < 8) { puladas.push('add:texto_curto'); continue; }
      // PROFILE CAP: doesn't cut anything. When the summary is already full, the new
      // fact goes to the area page (the caller needs to have loaded it, otherwise
      // saving would overwrite content that wasn't read).
      let rota = '';
      if (destino === PERFIL && fatosDe(linhasDoSlug(PERFIL)).length >= PERFIL_MAX) {
        if (Object.prototype.hasOwnProperty.call(paginas, OVERFLOW)) { destino = OVERFLOW; rota = ' [perfil-cheio]'; }
        else { puladas.push('add:perfil_cheio'); continue; }
      }
      const L = linhasDoSlug(destino);
      if (L.some((l) => norm(l) === norm(texto))) { puladas.push('add:duplicado'); continue; }
      const linha = texto.startsWith('-') ? texto : `- ${texto}`;
      inserirFato(L, linha);
      feitas.push(`add(${destino})${rota}`);
      mudancas.push({ op: 'add', pagina: destino, texto, ...tag });
    } else if (tipo === 'fix') {
      const L = linhasDoSlug(destino);
      const r = acharAncora(L, op?.ancora);
      if (r.erro) { puladas.push(`fix:${r.erro}`); continue; }
      const texto = String(op?.texto || '').replace(/\s+/g, ' ').trim();
      if (texto.length < 8) { puladas.push('fix:texto_curto'); continue; }
      const antes = L[r.i];
      // The corrected line stays at the same level (a subitem remains a subitem).
      L[r.i] = recuoDe(antes) + (texto.startsWith('-') ? texto : `- ${texto}`);
      feitas.push(`fix(${destino})`);
      mudancas.push({ op: 'fix', pagina: destino, texto, antes, ...tag });
    } else if (tipo === 'remove') {
      // Only the `memoria_anotar` tool emits 'remove' (housekeeping never deletes
      // on its own). Exists so the owner can say "take that out of memory" without
      // the model needing to rewrite the whole page just to delete a line.
      const L = linhasDoSlug(destino);
      const r = acharAncora(L, op?.ancora);
      if (r.erro) { puladas.push(`remove:${r.erro}`); continue; }
      const [fora] = L.splice(r.i, 1);
      feitas.push(`remove(${destino})`);
      mudancas.push({ op: 'remove', pagina: destino, texto: fora, ...tag });
    } else if (tipo === 'move') {
      const L = linhasDoSlug(PERFIL);
      const r = acharAncora(L, op?.ancora);
      if (r.erro) { puladas.push(`move:${r.erro}`); continue; }
      if (destino === PERFIL) { puladas.push('move:mesmo_destino'); continue; }
      // Texto LITERAL: mover nunca reescreve o fato.
      const [cru] = L.splice(r.i, 1);
      const linha = cru.trimStart();
      const D = linhasDoSlug(destino);
      if (!D.some((l) => norm(l) === norm(linha))) inserirFato(D, linha);
      feitas.push(`move(${destino})`);
      mudancas.push({ op: 'move', pagina: destino, texto: linha, de: PERFIL, ...tag });
    } else {
      puladas.push(`op_desconhecida(${tipo})`);
    }
  }
  // Returns ONLY the pages that actually changed: the caller saves whatever comes out of here.
  const paginasNovas = {};
  for (const [slug, L] of out) {
    const body = L.join('\n');
    if (body.trim() !== String(paginas[slug] ?? '').trim()) paginasNovas[slug] = body;
  }
  return { paginas: paginasNovas, feitas, puladas, mudancas };
}

// ── MEMORY v2, Phase 1: facts with key and validity ──
// A fact that has ONE current value (where they live, company, job title, size) gets a
// KEY (subject). Writing the same subject again swaps the old line instead
// of adding another one: that's what keeps "lives in SP" and "lives in Curitiba" from
// coexisting on the page. The fact lives in memory_facts; the page shows the line.
const MAX_FATOS_PROMPT = 80;

export function normAssunto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Accepts YYYY-MM-DD, YYYY-MM, YYYY and DD/MM/YYYY. Returns the date (first day
// of the period, for the database) and the text at the SAME precision it came in (so the page doesn't
// state a day nobody said).
export function parseDesde(v) {
  const t = String(v || '').trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { iso: t, txt: `${m[3]}/${m[2]}/${m[1]}` };
  if ((m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) return { iso: `${m[3]}-${m[2]}-${m[1]}`, txt: t };
  if ((m = t.match(/^(\d{4})-(\d{2})$/))) return { iso: `${m[1]}-${m[2]}-01`, txt: `${m[2]}/${m[1]}` };
  if ((m = t.match(/^(\d{4})$/))) return { iso: `${m[1]}-01-01`, txt: m[1] };
  return null;
}

const limpaValor = (v) => String(v || '').replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim();

export function linhaDoFato(valor, desdeTxt = '', antigo = '') {
  const extra = [desdeTxt ? `desde ${desdeTxt}` : '', antigo ? `antes: ${limpaValor(antigo)}` : ''].filter(Boolean);
  return `- ${limpaValor(valor)}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

// Value from a line the owner corrected by hand: strips the marker and the
// suffix that linhaDoFato adds.
export function valorDaLinha(linha) {
  return limpaValor(linha).replace(/\s\((?:desde|antes:)[^()]*\)$/, '').trim();
}

// Swaps `velho` for `novo` within the line only when `velho` appears ONCE,
// as a whole word (case-insensitive). Otherwise returns null.
export function trocarNaLinha(linha, velho, novo) {
  const v = limpaValor(velho);
  if (v.length < 3) return null;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu');
  if ((String(linha).match(re) || []).length !== 1) return null;
  return String(linha).replace(re, () => limpaValor(novo));
}

// Pure. Swaps each `definir` op for the equivalent line ops (fix on the line
// the fact already occupies; add if it's new or if the line disappeared; remove+add if it
// moved to a different page). Returns the expanded ops + the list of definitions to save.
export function expandirDefinir(ops, fatos, paginas, { maxOps = MAX_OPS } = {}) {
  const porAssunto = new Map((fatos || []).map((f) => [f.assunto, f]));
  const out = [], definicoes = [], puladas = [];
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, maxOps)) {
    if (String(op?.op || '').toLowerCase() !== 'definir') { out.push(op); continue; }
    const assunto = normAssunto(op.assunto);
    const valor = limpaValor(op.valor);
    if (!assunto) { puladas.push('definir:sem_assunto'); continue; }
    if (valor.length < 3) { puladas.push('definir:valor_curto'); continue; }
    const velho = porAssunto.get(assunto);
    const destino = normWikiSlug(op.pagina || velho?.pagina || PERFIL);
    const desde = parseDesde(op.desde);
    if (velho && norm(velho.valor) === norm(valor) && !desde) { puladas.push('definir:igual'); continue; }
    // Same value with a new date only fills in the date; it doesn't become "before: itself".
    const antigo = velho && norm(velho.valor) !== norm(valor) ? velho.valor : '';
    const linha = linhaDoFato(valor, desde?.txt, antigo);
    const idx = definicoes.length;
    definicoes.push({ assunto, valor, desde: desde?.iso || null, destino, linha });
    const corpoVelho = velho ? paginas[velho.pagina] : undefined;
    const velhoNaPagina = !!(velho?.linha_pagina && corpoVelho !== undefined
      && !acharAncora(linhasDe(corpoVelho), velho.linha_pagina).erro);
    // Composite line (e.g. the profile one with name, CPF and e-mail together, common in the
    // facts that came from migration): swapping the whole line would erase the rest.
    // Swaps only the old value within it, if it appears just once; if it can't
    // be found unambiguously, the old line stays and the fact gets its own line.
    const composta = velhoNaPagina && norm(valorDaLinha(velho.linha_pagina)) !== norm(velho.valor);
    if (composta && velho.pagina === destino && !antigo) {
      // Same value, just the new date: the line stays as is.
      definicoes[idx].linha = velho.linha_pagina;
    } else if (composta) {
      const trocada = velho.pagina === destino ? trocarNaLinha(velho.linha_pagina, velho.valor, valor) : null;
      if (trocada) { definicoes[idx].linha = trocada; out.push({ op: 'fix', pagina: destino, ancora: velho.linha_pagina, texto: trocada, _fato: idx }); }
      else out.push({ op: 'add', pagina: destino, texto: linha, _fato: idx });
    } else if (velhoNaPagina && velho.pagina === destino) {
      out.push({ op: 'fix', pagina: destino, ancora: velho.linha_pagina, texto: linha, _fato: idx });
    } else {
      if (velhoNaPagina) out.push({ op: 'remove', pagina: velho.pagina, ancora: velho.linha_pagina, _fato: idx });
      out.push({ op: 'add', pagina: destino, texto: linha, _fato: idx });
    }
  }
  return { ops: out, definicoes, puladas };
}

// Closes a memory question. Never decides on its own: the caller is either the owner (tool)
// or the admin (/metrics). After saving the fact, the versions that lost are
// removed from the pages (otherwise the assistant keeps seeing both and the question comes back
// in practice). Everything that changed stays in `desfazer`, and the old page stays in the copies.
export async function resolverDuvida(userId, id, { opcao = null, valor = null, descartar = false, por = 'dono', fonte = {} } = {}) {
  const d = await getMemoryAmbiguity(id);
  if (!d || d.user_id !== userId) return { ok: false, erro: 'dúvida não encontrada' };
  if (d.status !== 'aberta') return { ok: false, erro: `dúvida já está ${d.status}` };
  if (descartar) {
    await closeMemoryAmbiguity(id, { status: 'descartada', resolucao: null, por });
    return { ok: true, resolucao: 'descartada' };
  }
  const antes = (await listCurrentFacts(userId)).find((f) => f.assunto === d.assunto) || null;
  let resolucao, plano = [];
  if (opcao != null && String(opcao).trim()) {
    const o = (d.opcoes || []).find((x) => String(x.id) === String(opcao).trim());
    if (!o) return { ok: false, erro: `versão "${opcao}" não existe nessa dúvida` };
    const corpo = (await getWikiPage(userId, o.pagina))?.body || '';
    const linha = corpo.split('\n').find((l) => norm(l) === norm(o.txt));
    if (!linha) return { ok: false, erro: 'essa linha não está mais na página; mande o valor certo em texto' };
    resolucao = valorDaLinha(linha);
    const pl = await planoPerdedoras(userId, d, linha);
    if (pl.erro) return { ok: false, erro: pl.erro };
    plano = pl.plano;
    await setFact(userId, { pagina: o.pagina, assunto: d.assunto, valor: resolucao, linha, fonte: { ...fonte, origem: 'duvida', duvida: d.id, por } });
  } else {
    resolucao = limpaValor(valor);
    if (resolucao.length < 3) return { ok: false, erro: 'mande opcao, valor ou descartar' };
    const pl = await planoPerdedoras(userId, d, resolucao);
    if (pl.erro) return { ok: false, erro: pl.erro };
    plano = pl.plano;
    const titulos = Object.fromEntries((await listWikiPages(userId)).map((p) => [p.slug, p.title]));
    const res = await escreverComFatos(userId, [{ op: 'definir', assunto: d.assunto, valor: resolucao, pagina: d.opcoes?.[0]?.pagina }], {
      paginas: {}, titulos, fonte: { ...fonte, origem: 'duvida', duvida: d.id, por }, origem: 'conversa',
      logTag: `duvida=${d.id}`, criarPagina: true,
    });
    // "definir:igual" = the current fact already has this value: the question is answered.
    if (!res.fatos.length && !res.puladas.includes('definir:igual')) return { ok: false, erro: res.puladas.join(', ') || 'não gravou' };
  }
  const depois = (await listCurrentFacts(userId)).find((f) => f.assunto === d.assunto) || null;
  const edicoes = depois ? await aplicarPerdedoras(userId, plano, depois.linha_pagina) : [];
  await closeMemoryAmbiguity(id, {
    status: 'resolvida', resolucao, por,
    desfazer: { edicoes, fato_novo: depois && depois.id !== antes?.id ? depois.id : null, fato_velho: depois && antes && depois.id !== antes.id ? antes.id : null },
  });
  return { ok: true, resolucao, paginas_ajustadas: edicoes.length };
}

// Content words (no accents; 3+ letters or with a digit): these are what the
// check uses to decide if deleting a line would lose something.
const palavrasDe = (s) => new Set(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 || /\d/.test(w)));

const SYS_PERDEDORA = `A line in a person's memory contradicts the CORRECT version of a subject. Replace ONLY the piece that contradicts it: the rest of the line is other data, true, and must stay.
Return ONLY JSON {"trecho_errado":"EXACT copy, character by character, of the SMALLEST piece of the line that contradicts the correct version","trecho_certo":"what goes in its place, in the same style and language as the line, using only what the correct version says"}.
The wrong piece holds ONLY the words the correct version refutes. A detail it does not mention (background color, place, another person, another date) is not a conflict and stays.
If the line does not contradict the correct version (both can be true together), return {"manter":true}.
Only if the whole line says the same thing as the correct version, with no extra data at all, return {"apagar":true}.`;

// Fixes ONE losing line by swapping only the conflicting excerpt ("nothing may
// be lost"; before, the whole line was swapped and took true facts with it, e.g.
// a page lost "Algarve"). The model only points at the excerpt; the new line is
// built HERE with replace, so outside the excerpt it is the old one letter by
// letter. Delete the line only when each of its words is already in the winner.
async function corrigirPerdedora(assunto, velha, vencedora) {
  const r = await makeMemoriaModel().forBillingPhase({ kind: 'housekeeping' }).complete({
    system: SYS_PERDEDORA, tools: [],
    messages: [{ role: 'user', content: `Subject: ${assunto}\nCORRECT version: ${vencedora}\nLine to fix: ${velha}` }],
  });
  let j = null;
  try { j = JSON.parse(String(r.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { j = null; }
  if (!j) return { erro: 'resposta inválida do modelo' };
  if (j.manter === true) return { manter: true };
  if (j.apagar === true) {
    const V = palavrasDe(vencedora);
    const faltam = [...palavrasDe(velha)].filter((w) => !V.has(w));
    return faltam.length ? { erro: `apagar a linha perderia: ${faltam.slice(0, 6).join(', ')}` } : { depois: null };
  }
  const de = String(j.trecho_errado || ''), para = String(j.trecho_certo || '').trim();
  if (!de.trim() || !velha.includes(de)) return { erro: 'o trecho apontado não está na linha' };
  if (palavrasDe(de).size > Math.max(3, Math.ceil(palavrasDe(velha).size * 0.6))) return { erro: 'o trecho apontado é quase a linha inteira' };
  const depois = velha.replace(de, para);
  if (depois === velha || !depois.trim()) return { erro: 'a correção não mudou nada' };
  return { depois, trocou: { de, para } };
}

// Plans the fix for ALL the losing versions before saving anything: if one
// can't be fixed without loss, the question isn't resolved and no page changes.
// A line that backs a fact from ANOTHER subject isn't touched (the fact would end up pointing
// to a line that doesn't exist).
export async function planoPerdedoras(userId, d, vencedora) {
  const outros = (await listCurrentFacts(userId)).filter((f) => f.assunto !== d.assunto).map((f) => norm(f.linha_pagina));
  const plano = [];
  for (const o of d.opcoes || []) {
    if (norm(o.txt) === norm(vencedora) || outros.includes(norm(o.txt))) continue;
    const linha = ((await getWikiPage(userId, o.pagina))?.body || '').split('\n').find((l) => norm(l) === norm(o.txt));
    if (!linha) continue;
    const c = await corrigirPerdedora(d.assunto, linha, vencedora);
    if (c.erro) return { erro: `não consegui corrigir a versão ${o.id} sem perder texto (${c.erro}); a dúvida continua aberta` };
    if (c.manter) { plano.push({ pagina: o.pagina, antes: linha, manter: true }); continue; }
    plano.push({ pagina: o.pagina, antes: linha, depois: c.depois, trocou: c.trocou || null });
  }
  return { plano };
}

// Applies the plan line by line, keeping the index so undo can find the right place.
async function aplicarPerdedoras(userId, plano, vencedora) {
  const edicoes = [];
  const porPagina = new Map();
  for (const p of plano) {
    if (p.manter || norm(p.antes) === norm(vencedora)) continue;
    if (!porPagina.has(p.pagina)) porPagina.set(p.pagina, []);
    porPagina.get(p.pagina).push(p);
  }
  for (const [slug, ps] of porPagina) {
    const pag = await getWikiPage(userId, slug);
    if (!pag) continue;
    const linhas = pag.body.split('\n');
    let mudou = false;
    for (const p of ps) {
      const i = linhas.findIndex((l) => norm(l) === norm(p.antes));
      if (i < 0) continue;
      if (p.depois == null) {
        edicoes.push({ pagina: slug, idx: i, antes: linhas[i], depois: null, apos: i > 0 ? linhas[i - 1] : null });
        linhas.splice(i, 1);
      } else {
        edicoes.push({ pagina: slug, idx: i, antes: linhas[i], depois: p.depois, trocou: p.trocou });
        linhas[i] = p.depois;
      }
      mudou = true;
    }
    if (mudou) await upsertWikiPage(userId, { slug, title: pag.title, body: linhas.join('\n') });
  }
  return edicoes;
}

// Index of the occurrence of `alvo` closest to `idx` (the page may have changed
// since the resolution; the text rules, the index only breaks ties).
function acharPerto(linhas, alvo, idx) {
  let melhor = -1;
  linhas.forEach((l, i) => { if (norm(l) === norm(alvo) && (melhor < 0 || Math.abs(i - idx) < Math.abs(melhor - idx))) melhor = i; });
  return melhor;
}

// Undoes a resolution: returns the lines to the pages, undoes the fact swap and
// reopens the question. A discarded one just reopens.
export async function desfazerDuvida(userId, id) {
  const d = await getMemoryAmbiguity(id);
  if (!d || d.user_id !== userId) return { ok: false, erro: 'dúvida não encontrada' };
  if (d.status === 'aberta') return { ok: false, erro: 'dúvida já está aberta' };
  const u = d.desfazer || {};
  const naoVoltou = [];
  const porPagina = new Map();
  for (const e of u.edicoes || []) {
    if (!porPagina.has(e.pagina)) porPagina.set(e.pagina, []);
    porPagina.get(e.pagina).push(e);
  }
  for (const [slug, eds] of porPagina) {
    const pag = await getWikiPage(userId, slug);
    const linhas = (pag?.body || '').split('\n');
    // Back to front: undoes in the reverse order of application.
    for (const e of [...eds].reverse()) {
      if (e.depois != null) {
        const i = acharPerto(linhas, e.depois, e.idx);
        if (i < 0) { naoVoltou.push(e.antes); continue; }
        linhas[i] = e.antes;
      } else {
        const j = e.apos != null ? acharPerto(linhas, e.apos, e.idx - 1) : -1;
        linhas.splice(j >= 0 ? j + 1 : Math.min(e.idx, linhas.length), 0, e.antes);
      }
    }
    await upsertWikiPage(userId, { slug, title: pag?.title || tituloDe(slug), body: linhas.join('\n') });
  }
  if (u.fato_novo || u.fato_velho) await revertFactSwap(userId, { novo: u.fato_novo, velho: u.fato_velho });
  if (!(await reopenMemoryAmbiguity(id, d.status))) return { ok: false, erro: 'a dúvida mudou enquanto desfazia; recarregue' };
  return { ok: true, linhas_que_nao_voltaram: naoVoltou };
}

// Single memory write path (tool and housekeeping): expands `definir`, applies,
// saves pages, saves facts and keeps facts in sync with line fixes
// made via the old paths (fix/remove/move). `paginas` = bodies already read;
// the pages the facts touch are loaded here.
// R1+R3 (see wiki-reconciliar.mjs): swaps each add/definir for what the reconciler
// decided. "Already there" skips the op; "update" becomes a definir on the line that already
// exists (a line without a fact gets a synthetic fact with the old value, so the swap leaves
// history in memory_facts); the other pages that repeat the old value
// get a fix on just the excerpt. Model error = the op goes through as it came.
async function reconciliar(userId, ops, { paginas, fatos, titulos, dryRun, fonte }) {
  const ALVO = new Set(['add', 'definir']);
  if (!ops.some((op) => ALVO.has(String(op?.op || '').toLowerCase()))) return { ops, puladas: [] };
  for (const p of await listWikiPagesFull(userId)) {
    if (!Object.prototype.hasOwnProperty.call(paginas, p.slug)) paginas[p.slug] = p.body || '';
    if (!titulos[p.slug]) titulos[p.slug] = p.title;
  }
  const corpos = { ...paginas };
  const fatoDaLinha = (pag, linha) => fatos.find((f) => f.pagina === pag && norm(f.linha_pagina) === norm(linha));
  const porAssunto = new Map(fatos.map((f) => [f.assunto, f]));
  const planos = await Promise.all(ops.map(async (op) => {
    const tipo = String(op?.op || '').toLowerCase();
    if (!ALVO.has(tipo)) return null;
    const f = tipo === 'definir' ? porAssunto.get(normAssunto(op.assunto)) : null;
    try {
      return await planejarOp(op, corpos, { linhaPropria: f?.linha_pagina || '', valorAntigo: f?.valor || '' });
    } catch (e) { console.error('[memoria conciliar]', e?.message ?? e); return null; }
  }));
  const sintetico = async (assunto, pagina, valor, linha) => {
    let a = normAssunto(assunto) || 'assunto', n = 2;
    while (porAssunto.has(a)) a = `${normAssunto(assunto) || 'assunto'}_${n++}`;
    const f = { assunto: a, pagina, valor, linha_pagina: linha };
    fatos.push(f); porAssunto.set(a, f);
    if (!dryRun) await setFact(userId, { pagina, assunto: a, valor, linha, fonte: { ...fonte, origem: 'conciliador' } });
    return a;
  };
  const out = [], puladas = [], tocadas = new Set();
  const chave = (c) => `${c.pagina}\n${norm(c.linha)}`;
  for (const p of planos) if (p?.cand) tocadas.add(chave(p.cand));
  for (const [i, op] of ops.entries()) {
    const p = planos[i];
    if (!p) { out.push(op); continue; }
    const tipo = String(op.op).toLowerCase();
    const log = `[memoria conciliar] u=${String(userId).slice(0, 8)} ${tipo} -> ${p.acao}${p.cand ? `(${p.cand.pagina})` : ''} outras=${p.outras.length}${p.erro ? ` erro=${p.erro}` : ''}`;
    console.log(log);
    if (p.acao === 'nada') {
      if (tipo === 'definir' && !fatoDaLinha(p.cand.pagina, p.cand.linha)) await sintetico(op.assunto, p.cand.pagina, valorDaLinha(p.cand.linha), p.cand.linha);
      puladas.push(`${tipo}:ja_existe(${p.cand.pagina})`);
    } else if (p.acao === 'atualizar') {
      const f = fatoDaLinha(p.cand.pagina, p.cand.linha);
      const simples = f && norm(valorDaLinha(f.linha_pagina)) === norm(f.valor);
      if (f && simples) out.push({ op: 'definir', assunto: f.assunto, valor: tipo === 'definir' ? op.valor : valorDaLinha(p.nova), pagina: f.pagina, desde: op.desde });
      else if (f && f.valor.includes(p.de)) out.push({ op: 'definir', assunto: f.assunto, valor: f.valor.replace(p.de, p.para), pagina: f.pagina, desde: op.desde });
      else if (f) out.push({ op: 'fix', pagina: p.cand.pagina, ancora: p.cand.linha, texto: p.nova, _de: p.de });
      else {
        const a = await sintetico(tipo === 'definir' ? op.assunto : p.assunto, p.cand.pagina, p.de, p.cand.linha);
        out.push({ op: 'definir', assunto: a, valor: p.para, pagina: p.cand.pagina, desde: op.desde });
      }
    } else out.push(op);
    for (const o of p.outras) {
      if (tocadas.has(chave(o.cand))) continue;
      tocadas.add(chave(o.cand));
      out.push({ op: 'fix', pagina: o.cand.pagina, ancora: o.cand.linha, texto: o.nova, _de: o.de });
    }
  }
  return { ops: out, puladas };
}

// Housekeeping runs after the turn, reading only the conversation. If in the SAME turn
// the assistant already saved the fact via the tool (or the reconciler decided), that
// write is the newest and most explicit: housekeeping can't overwrite it
// with a value it pulled from an older message (seen in prod on 2026-09-25:
// R$619 saved by the tool became R$522 three seconds later). Filters BEFORE the
// reconciler, which also writes facts directly.
export function filtrarEscritoNoTurno(ops, fatos, origem, turnId) {
  const puladas = [];
  if (origem !== 'housekeeping' || !turnId) return { ops, puladas };
  const protegidos = (fatos || []).filter((f) => f.fonte?.turn_id === turnId && f.fonte?.origem !== 'housekeeping');
  if (!protegidos.length) return { ops, puladas };
  const assuntos = new Set(protegidos.map((f) => f.assunto));
  const linhas = protegidos.map((f) => norm(f.linha_pagina)).filter(Boolean);
  const bate = (ancora) => { const a = norm(ancora); return !!a && linhas.some((n) => n === a || n.includes(a) || a.includes(n)); };
  const ficam = (ops || []).filter((op) => {
    const t = String(op?.op || '').toLowerCase();
    const alvo = t === 'definir' ? (assuntos.has(normAssunto(op.assunto)) ? op.assunto : '')
      : (t === 'fix' || t === 'remove' || t === 'move') && bate(op.ancora) ? op.ancora : '';
    if (alvo) puladas.push(`${t}:escrito_no_turno(${String(alvo).slice(0, 60)})`);
    return !alvo;
  });
  return { ops: ficam, puladas };
}

async function escreverComFatos(userId, ops, { paginas, titulos = {}, fonte = {}, origem = '', dryRun = false, logTag = '', criarPagina = false }) {
  const fatos = await listCurrentFacts(userId);
  const hk = filtrarEscritoNoTurno(ops, fatos, fonte.origem || origem, fonte.turn_id);
  ops = hk.ops;
  let pulRec = [], maxOps = MAX_OPS;
  if (reconciliarLigado()) {
    const r = await reconciliar(userId, (ops || []).slice(0, MAX_OPS), { paginas, fatos, titulos, dryRun, fonte });
    ops = r.ops; pulRec = r.puladas; maxOps = Math.max(MAX_OPS, ops.length);
  }
  const porAssunto = new Map(fatos.map((f) => [f.assunto, f]));
  const carregar = async (slug) => {
    if (slug && !Object.prototype.hasOwnProperty.call(paginas, slug)) paginas[slug] = (await getWikiPage(userId, slug))?.body || '';
  };
  for (const op of ops || []) {
    if (String(op?.op || '').toLowerCase() !== 'definir') continue;
    const velho = porAssunto.get(normAssunto(op.assunto));
    const destino = normWikiSlug(op.pagina || velho?.pagina || PERFIL);
    // Housekeeping doesn't create a page outside the known list (same as its add);
    // the tool can, as memoria_anotar always could.
    if (criarPagina || destino === PERFIL || titulos[destino] || CANONICAS.includes(destino) || ehPaginaDePessoa(destino)) await carregar(destino);
    if (destino === PERFIL) await carregar(OVERFLOW);
    if (velho) await carregar(velho.pagina);
  }
  const exp = expandirDefinir(ops, fatos, paginas, { maxOps });
  const res = aplicarOps(exp.ops, paginas, { maxOps: exp.ops.length });
  res.puladas.unshift(...hk.puladas, ...pulRec, ...exp.puladas);
  for (const [slug, body] of Object.entries(res.paginas)) {
    if (!dryRun) await upsertWikiPage(userId, { slug, title: titulos[slug] || tituloDe(slug), body });
    logDiffPerfil(userId, slug, paginas[slug] ?? '', body, `${logTag} ops=${res.feitas.join(',') || '-'}${dryRun ? ' DRYRUN' : ''}`);
  }
  const gravados = [];
  if (!dryRun) {
    for (const [idx, d] of exp.definicoes.entries()) {
      const m = res.mudancas.find((x) => x.fato === idx && (x.op === 'add' || x.op === 'fix'));
      let pagina = m?.pagina, linha = m ? (m.texto.startsWith('-') ? m.texto : `- ${m.texto}`) : '';
      if (!m) {
        // An identical line was already on the page (add:duplicate): the fact starts pointing to it.
        const corpo = res.paginas[d.destino] ?? paginas[d.destino] ?? '';
        if (linhasDe(corpo).some((l) => norm(l) === norm(d.linha))) { pagina = d.destino; linha = d.linha; }
      }
      if (!pagina) { res.puladas.push(`definir:nao_gravado(${d.assunto})`); continue; }
      await setFact(userId, { pagina, assunto: d.assunto, valor: d.valor, desde: d.desde, linha, fonte: { ...fonte, origem: fonte.origem || origem } });
      gravados.push(d.assunto);
    }
    // Old paths touching a line that belongs to a fact: the fact follows along.
    for (const m of res.mudancas) {
      if (m.fato != null) continue;
      const alvo = m.op === 'fix' ? m.antes : m.texto;
      const pag = m.op === 'move' ? m.de : m.pagina;
      const f = fatos.find((x) => x.pagina === pag && norm(x.linha_pagina) === norm(alvo));
      if (!f) {
        // A line without a fact that got corrected or deleted: the old version becomes history.
        if (historicoLigado() && (m.op === 'fix' || m.op === 'remove')) {
          const velha = m.op === 'fix' ? m.antes : m.texto;
          if (norm(velha) !== norm(m.op === 'fix' ? m.texto : '')) {
            await addHistorico(userId, { pagina: pag, linha: velha, valor: valorDaLinha(velha),
              fonte: { ...fonte, origem: fonte.origem || origem, op: m.op, ...(m.op === 'fix' ? { virou: m.texto } : {}) } });
          }
        }
        continue;
      }
      const nova = m.texto.startsWith('-') ? m.texto : `- ${m.texto}`;
      if (m.op === 'remove') await closeFact(userId, f.id);
      else if (m.op === 'fix') {
        // Composite line: the fact's value is only a piece of it. If the piece
        // is still there, only the line changes; value = whole line only for a simple line.
        const composta = norm(valorDaLinha(f.linha_pagina)) !== norm(f.valor);
        const aindaLa = composta && norm(nova).includes(norm(f.valor));
        if (!aindaLa && historicoLigado() && norm(valorDaLinha(nova)) !== norm(f.valor)) {
          // Value changed by hand: closes the fact and opens another, instead of overwriting
          // (overwriting erased the old value without leaving history).
          await setFact(userId, { pagina: m.pagina, assunto: f.assunto, valor: valorDaLinha(nova), linha: nova, fonte: { ...fonte, origem: fonte.origem || origem } });
        } else {
          // Composite line: the fact's value stayed, but another piece of the line changed.
          if (historicoLigado() && norm(f.linha_pagina) !== norm(nova)) {
            await addHistorico(userId, { pagina: pag, linha: f.linha_pagina, valor: valorDaLinha(f.linha_pagina), fonte: { ...fonte, origem: fonte.origem || origem, op: 'fix', virou: nova } });
          }
          await updateFactLine(userId, f.id, aindaLa ? { pagina: m.pagina, linha: nova } : { pagina: m.pagina, linha: nova, valor: valorDaLinha(nova) });
        }
      }
      else if (m.op === 'move') await updateFactLine(userId, f.id, { pagina: m.pagina, linha: nova });
    }
    await posEscrita(userId, res.mudancas, origem);
  }
  return { ...res, fatos: gravados, definicoes: exp.definicoes };
}

// ── Profile links section (generated, never written by the model) ──
// The profile becomes Town's "overview": the short facts + an index of the area
// pages. Only the section after the marker is rewritten; the text above it is copied
// VERBATIM (including blank lines), so this never loses or reformats a fact.
// PURE part (no database, which is why it has a test): receives the profile's current body and the
// list of pages, returns the body with the links section redone, or null if the
// swap would lose a line that isn't part of the generated block.
export function montarPerfilComLinks(antes, outras) {
  const cru = String(antes || '').split('\n');
  const i = iMarca(cru);
  const fatos = i < 0 ? cru.slice() : cru.slice(0, i);
  while (fatos.length && !fatos[fatos.length - 1].trim()) fatos.pop();
  // Only the GENERATED BLOCK comes out of here: the marker and the lines in the exact format
  // this function writes. Whatever comes after belongs to the owner and is copied verbatim.
  // Before, the cutoff was "everything below the marker", so anything written
  // under the links section disappeared on every memory write (finding #17).
  let j = i < 0 ? -1 : i + 1;
  while (j >= 0 && j < cru.length && (!cru[j].trim() || EH_LINK_GERADO.test(cru[j].trim()))) j++;
  const rabo = j < 0 ? [] : cru.slice(j);
  while (rabo.length && !rabo[0].trim()) rabo.shift();
  while (rabo.length && !rabo[rabo.length - 1].trim()) rabo.pop();
  const secao = (outras || []).length
    ? ['', `${MARCA_LINKS} (leia com memoria_ler quando a tarefa pedir)`, ...outras.map((p) => `- ${p.slug} — ${p.title || tituloDe(p.slug)}`)]
    : [];
  const body = [...fatos, ...secao, ...(rabo.length ? ['', ...rabo] : [])].join('\n');
  // Safety guard: this function is automatic and runs after EVERY write,
  // so it can never be the reason a line disappears. If any loss remains that
  // isn't from the generated block, the caller doesn't save anything.
  const perdidas = diffPerfil(antes, body).perdidas
    .filter((l) => !EH_LINK_GERADO.test(l) && !l.trimStart().startsWith(MARCA_LINKS));
  return perdidas.length ? null : body;
}

export async function sincronizarLinks(userId) {
  const pages = await listWikiPages(userId);
  const outras = pages.filter((p) => p.slug !== PERFIL && p.slug !== ATUALIZACOES);
  const perfil = await getWikiPage(userId, PERFIL);
  const antes = String(perfil?.body || '');
  if (!antes.trim() && !outras.length) return false;
  const body = montarPerfilComLinks(antes, outras);
  if (body === null) {
    console.error(`[memoria links] u=${String(userId).slice(0, 8)} aborted: the sync would lose a profile line`);
    return false;
  }
  if (body.trim() === antes.trim()) return false;
  await upsertWikiPage(userId, { slug: PERFIL, title: perfil?.title || 'Perfil', body });
  return true;
}

// ── "Recent updates" (the box Town shows) ──
// Generated for free from the operations the server HAS ALREADY applied: zero model
// call, zero chance of making things up. It's a LOG (the facts live on the pages), so
// here there IS a cap on entries.
export async function registrarAtualizacao(userId, mudancas, origem = '') {
  const lista = (Array.isArray(mudancas) ? mudancas : []).filter((m) => m?.pagina);
  if (!lista.length) return false;
  const timeZone = (await getUserTimezone(userId).catch(() => null)) || defaultTimezone();
  const quando = new Date().toLocaleString('pt-BR', {
    timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const porPagina = new Map();
  for (const m of lista) porPagina.set(m.pagina, (porPagina.get(m.pagina) || 0) + 1);
  const resumo = [...porPagina].map(([p, n]) => (n > 1 ? `${p} (${n})` : p)).join(', ');
  const sinal = { add: '+', fix: '~', remove: '−', move: '→', write: '±' };
  const bloco = [
    `- ${quando} — ${resumo}${origem ? ` · ${origem}` : ''}`,
    ...lista.slice(0, 5).map((m) => `  ${sinal[m.op] || '·'} ${String(m.texto || '').replace(/\s+/g, ' ').trim().slice(0, 180)}${m.de ? ` (era: ${String(m.de).trim().slice(0, 80)})` : m.op === 'fix' && m.antes && historicoLigado() ? ` (era: ${limpaValor(m.antes).slice(0, 120)})` : ''}`),
  ];
  const atual = await getWikiPage(userId, ATUALIZACOES);
  const cru = String(atual?.body || '').split('\n');
  const ini = cru.findIndex((l) => l.startsWith('- '));
  const antigas = ini < 0 ? [] : cru.slice(ini);
  const juntas = [...bloco, ...antigas];
  let entradas = 0, corte = juntas.length;
  for (let i = 0; i < juntas.length; i++) {
    if (juntas[i].startsWith('- ') && ++entradas > MAX_ATUALIZACOES) { corte = i; break; }
  }
  await upsertWikiPage(userId, {
    slug: ATUALIZACOES, title: 'Atualizações recentes',
    body: [CAB_ATUALIZACOES, '', ...juntas.slice(0, corte)].join('\n'),
  });
  return true;
}

// Called after every memory write: records what changed and redoes the
// profile links. Never lets an error here bring down a write that already happened.
async function posEscrita(userId, mudancas, origem) {
  try { await registrarAtualizacao(userId, mudancas, origem); } catch (e) { console.error('[memoria atualizacoes]', e?.message ?? e); }
  try { await sincronizarLinks(userId); } catch (e) { console.error('[memoria links]', e?.message ?? e); }
}

// Concrete values from the text (link, domain, e-mail, 4+ digit number) that don't
// appear in the source. Compares case-insensitively, without a trailing slash and with digits
// stuck together ("(11) 98765-4321" matches "11987654321").
const colaDigitos = (t) => String(t || '').toLowerCase().replace(/(\d)[\s.\-/()]+(?=\d)/g, '$1');
export function valoresSemBase(texto, fonte) {
  const t = String(texto || '').toLowerCase();
  const f = String(fonte || '').toLowerCase();
  const fd = colaDigitos(f);
  const falta = [];
  const links = t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s)\]"'<>]*)?/g) || [];
  for (const l of links) {
    const limpo = l.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,;:!?/]+$/, '');
    if (limpo && !/^\d/.test(limpo) && !f.includes(limpo)) falta.push(l);
  }
  const runs = new Set(fd.match(/\d+/g) || []);
  for (const n of colaDigitos(t).match(/\d{4,}/g) || []) if (!runs.has(n)) falta.push(n);
  return falta;
}

// A function because of language: memory is DURABLE DATA, it is stored and comes
// back into the prompt on every future turn. Leaving its language to a soft
// guideline would mean memory in Portuguese for an account that does not speak
// Portuguese, forever. The tag (pt-BR, en, es) sets the language the lines are
// written in; the prompt itself is in English.
const sysPatch = (language) => [
  'You maintain the long-term MEMORY of a user of a personal assistant.',
  'You receive the current memory and the latest exchange of messages. Return ONLY write operations, in JSON.',
  '',
  'Format (pure JSON, no markdown, no comments):',
  `{"ops":[{"op":"definir","pagina":"perfil","assunto":"cidade_onde_mora","valor":"<full line in ${tagIdioma(language)}, e.g. Lives in Curitiba>","desde":"2026-09"},{"op":"add","pagina":"preferencias","texto":"..."},{"op":"fix","pagina":"perfil","ancora":"literal excerpt of the line that is wrong","texto":"whole corrected line"}]}`,
  'If there is nothing durable to store (the MOST COMMON case), return {"ops":[]}.',
  '',
  'Rules:',
  '- Store only DURABLE, useful facts: preferences, context (profession, routine), recurring goals, restrictions, sizes/brands, decisions made.',
  '- NEVER store small talk, one-off questions, the result of a task, or anything ephemeral.',
  '- NEVER include TONE/VOICE/STYLE/FORMATTING instructions for the assistant (e.g. "be formal", "keep answers short"). Those are per-assistant and would leak into the person\'s other assistants. Memory is only about WHO the user is.',
  '- A fact that has ONE current value and can change (where they live, company, job title, size, main goal, plan/subscription) = "definir", with a short, stable snake_case key (assunto). If the subject is ALREADY in the list of keyed facts, reuse EXACTLY that key: the server replaces the old line on its own.',
  '- "desde" only when the conversation says when it started (YYYY-MM-DD, YYYY-MM or YYYY). Never invent a date; without a date, omit the field.',
  '- A fact that only accumulates (likes X, has traveled to Y) = "add".',
  '- Use "fix" only when the exchange CONTRADICTS a line already noted that is NOT in the list of keyed facts. The anchor must be a literal excerpt of ONE existing line.',
  '- Countable, dated logs (ate, trained, spent), an ongoing plan/journey, and app data are NOT memory: do not store them.',
  '- Never rewrite the whole page and never summarize what is already there. One operation = one fact.',
  '- Every link, e-mail, phone number, code or number you store must be WRITTEN in the exchange or in the current memory. If the person said something changed but did not give the new value (e.g. "I changed the link" without the link), store nothing: never fill in a likely value.',
  `- One line per fact, short, in ${tagIdioma(language)}. At most 3 operations.`,
  '',
  'Where to store:',
  `- "perfil" is the BIG SUMMARY: only what defines the person and is useful in almost every conversation (at most ~${PERFIL_MAX} facts).`,
  `- Detail goes to an area page: ${Object.keys(AREAS).join(', ')}.`,
  '- A fact about a specific PERSON goes to one page per person, in the format "pessoa-nome" (e.g. "pessoa-ana").',
  '- If the profile is already at its cap, the server sends the fact to "notas" on its own; prefer choosing the right page from the start.',
].join('\n');

// Memory maintenance by PATCH (default). Returns {usage, ops, feitas, puladas}.
// `dryRun` runs everything except the write (used in the memory evals, read-only).
export async function patchUserProfile(userId, userMsg, assistantMsg, { dryRun = false, language = null, fonte = {} } = {}) {
  const todas = await listWikiPages(userId);
  const perfilBody = (await getWikiPage(userId, PERFIL))?.body || '';
  const outras = todas.filter((p) => p.slug !== PERFIL).map((p) => p.slug);
  const fatos = await listCurrentFacts(userId, { limit: MAX_FATOS_PROMPT });
  const prompt = [
    `Current memory ("perfil" page):\n${perfilBody.trim() || '(empty)'}`,
    outras.length ? `\nOther existing pages (valid destinations): ${outras.join(', ')}` : '',
    fatos.length ? `\nKeyed facts (subject [page]: current value):\n${fatos.map((f) => `- ${f.assunto} [${f.pagina}]: ${String(f.valor).slice(0, 120)}`).join('\n')}` : '',
    `\nLatest exchange:\nUser: ${userMsg}\nAgent: ${assistantMsg}`,
  ].join('\n');
  const r = await makeMemoriaModel().forBillingPhase({kind:'housekeeping'}).complete({
    system: sysPatch(language), messages: [{ role: 'user', content: prompt }], tools: [],
  });
  const bruto = (r.text || '').trim();
  let ops = null;
  try {
    const m = bruto.match(/\{[\s\S]*\}/);           // tolerates a markdown fence
    ops = m ? JSON.parse(m[0])?.ops : null;
  } catch { ops = null; }
  if (!Array.isArray(ops)) {
    // VISIBLE failure: writes nothing. Memory stays as it was and the next
    // cycle tries again (the fact is still in the history).
    console.log(`[perfil patch] u=${String(userId).slice(0, 8)} json_invalido len=${bruto.length}`);
    return { usage: r.usage, ops: [], feitas: [], puladas: ['json_invalido'] };
  }
  if (!ops.length) return { usage: r.usage, ops, feitas: [], puladas: [] };

  // Model-free gate: a concrete value (link, e-mail, 4+ digit number) that isn't
  // written in the change nor in memory was made up. On 2026-09-24 the eval caught
  // "I changed the link" with no link turning into a plausible address saved as current.
  const base = [userMsg, assistantMsg, perfilBody, ...fatos.map((f) => f.valor), `hoje: ano ${new Date().getFullYear()}`];
  for (const slug of outras) base.push((await getWikiPage(userId, slug))?.body || '');
  const semBase = [];
  ops = ops.filter((op) => {
    const falta = valoresSemBase([op?.valor, op?.texto].filter(Boolean).join(' '), base.join('\n'));
    if (falta.length) semBase.push(`sem_base(${op?.op}:${falta[0].slice(0, 40)})`);
    return !falta.length;
  });
  if (!ops.length) {
    console.log(`[perfil patch] u=${String(userId).slice(0, 8)} puladas=${semBase.join(',')}`);
    return { usage: r.usage, ops, feitas: [], puladas: semBase };
  }

  const paginas = { [PERFIL]: perfilBody };
  for (const op of ops) {
    const slug = op?.pagina ? normWikiSlug(op.pagina) : '';
    if (slug && slug !== PERFIL && outras.includes(slug)) {
      paginas[slug] = (await getWikiPage(userId, slug))?.body || '';
    }
    // Destination profile + cap reached = the fact is ROUTED to the overflow page;
    // it needs to be loaded so the write doesn't overwrite what already exists.
    if ((!slug || slug === PERFIL) && !Object.prototype.hasOwnProperty.call(paginas, OVERFLOW)) {
      paginas[OVERFLOW] = (await getWikiPage(userId, OVERFLOW))?.body || '';
    }
  }
  const res = await escreverComFatos(userId, ops, {
    paginas, titulos: Object.fromEntries(todas.map((p) => [p.slug, p.title])),
    fonte: { ...fonte, origem: 'housekeeping' }, origem: 'automático', dryRun,
  });
  res.puladas.push(...semBase);
  if (res.puladas.length) {
    console.log(`[perfil patch] u=${String(userId).slice(0, 8)} puladas=${res.puladas.join(',')}`);
  }
  return { usage: r.usage, ops, feitas: res.feitas, puladas: res.puladas, paginas: res.paginas, antes: paginas, fatos: res.fatos };
}

// Automatic per-turn maintenance of the `perfil` page (user layer, per person).
// Since 2026-09-02 the default is PATCH (above); `PERFIL_MODO=rewrite` reverts to the
// old rewrite behavior without needing a deploy.
export async function updateUserProfile(userId, userMsg, assistantMsg, { language = null, fonte = {} } = {}) {
  if (process.env.PERFIL_MODO !== 'rewrite') {
    try {
      return await patchUserProfile(userId, userMsg, assistantMsg, { language, fonte });
    } catch (e) {
      console.error('[perfil patch]', e?.message ?? e);
      return null;
    }
  }
  const atual = (await getWikiPage(userId, PERFIL))?.body || '';
  const sys = [
    'You maintain a short, stable PROFILE of the user of a personal assistant.',
    'Store only lasting, useful facts: preferences, context (profession, family, routine), recurring goals, restrictions, sizes/brands and decisions made.',
    `Do NOT store small talk, one-off questions or anything ephemeral. At most ~12 lines, short bullets, in ${tagIdioma(language)}.`,
    'Do NOT include TONE/VOICE/STYLE/FORMATTING instructions about how the assistant should write or behave (e.g. "be formal", "keep answers short", "no emoji"). That is configured per-assistant elsewhere and would leak into the user\'s other assistants if it went in here. This profile is only about WHO the user is.',
    'Return the whole UPDATED profile (current profile + what you learned now, without duplicating). Only the profile, no comments.',
  ].join('\n');
  const prompt = `Current profile:\n${atual.trim() || '(empty)'}\n\nNew exchange:\nUser: ${userMsg}\nAgent: ${assistantMsg}`;
  try {
    // Housekeeping: fact extraction doesn't need expensive reasoning -> zeroes
    // out the thinking (which dominated the cost of this per-turn call).
    const r = await makeMemoriaModel().forBillingPhase({kind:'housekeeping'}).complete({
      system: sys, messages: [{ role: 'user', content: prompt }], tools: [],
    });
    const novo = r.text?.trim();
    if (novo && novo !== atual.trim()) {
      await upsertWikiPage(userId, { slug: PERFIL, title: 'Perfil', body: novo });
      logDiffPerfil(userId, PERFIL, atual, novo, 'modo=rewrite');
    }
    // Returns the usage to the caller to save the cost (kind='housekeeping').
    return { usage: r.usage };
  } catch {
    // if it fails, keeps the profile it already had
    return null;
  }
}
