// ── Wiki de memória por usuário (modelo Karpathy) ──
// Páginas markdown que o agente lê/escreve, COMPARTILHADAS entre todos os Claws
// da mesma pessoa (camada "usuário"). Vive no Postgres (multi-tenant, não em
// arquivo solto). Expõe tools file-like no tool-loop + injeta um índice + a
// página `perfil` no system prompt. Ver projetos/arquitetura-memoria.md.

import { listWikiPages, listWikiPagesFull, getWikiPage, upsertWikiPage, searchWikiPages, normWikiSlug, listCurrentFacts, listAllFacts, setFact, closeFact, updateFactLine, addHistorico, listMemoryAmbiguities, getMemoryAmbiguity, closeMemoryAmbiguity, reopenMemoryAmbiguity, revertFactSwap } from './db.mjs';
import { makeMemoriaModel } from './memoria-modelo.mjs';
import { tagIdioma } from './locale.mjs';
import { buscaV2Ligada, buscarNaMemoria, formatarAchados } from './memoria-busca.mjs';
import { reconciliarLigado, planejarOp } from './wiki-reconciliar.mjs';

// Página sempre-injetada: o "quem você é" curto e estável (sucessora do perfil plano).
const PERFIL = 'perfil';

// ── PHASE 2: perfil = short OVERVIEW linking to the areas ──
// Format inspired by what Town does: the main page is a summary with links to
// the area pages, each topic has its own page, and there is a log of what
// changed. Invariant of this phase: NOTHING is deleted and NOTHING is
// truncated. The profile cap doesn't cut lines: it ROUTES the new fact to an
// area page. What is already written only moves in Phase 4, with a dry run.
const AREAS = {
  // facetas (o corte por FUNÇÃO que o Town usa)
  comunicacao: 'Como se comunica',
  preferencias: 'Preferências',
  background: 'Background profissional',
  rotina: 'Padrões e rotina',
  rede: 'Rede pessoal e profissional',
  objetivos: 'Objetivos',
  projetos: 'Projetos',
  notas: 'Notas',
  // páginas por assunto que já existiam antes da Fase 2 (seguem valendo)
  pessoas: 'Pessoas',
  trabalho: 'Trabalho',
  saude: 'Saúde',
  alimentacao: 'Alimentação',
  treinos: 'Treinos',
  financas: 'Finanças',
  casa: 'Casa',
  compras: 'Compras',
};
const OVERFLOW = 'notas';            // onde o fato cai quando o perfil está no teto
// R4 (flag MEMORIA_HISTORICO=1): nenhuma linha sai da página sem deixar a versão
// antiga no histórico (memory_facts encerrado), inclusive linha que não é de fato.
export const historicoLigado = () => process.env.MEMORIA_HISTORICO === '1';
const ATUALIZACOES = 'atualizacoes'; // registro do que mudou; mantido só pelo servidor
const MARCA_LINKS = '## Mais detalhe';
const CAB_ATUALIZACOES = 'O que mudou na sua memória (mais recente primeiro). Página mantida automaticamente.';
const MAX_ATUALIZACOES = 60;
// Teto de FATOS do perfil (o resto vira link). Sobrescrevível sem deploy.
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

// Monta as tools de wiki pra ESTE usuário (entram no registry por requisição).
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
        // A chave do slug entra no mapa mesmo vazia: assim `aplicarOps` aceita o
        // destino e a página é CRIADA no primeiro `add`, sem precisar de outra tool.
        const antesPor = { [slug]: atual?.body || '' };
        // Se o destino é o perfil, carrega também a página de overflow: o teto do
        // perfil ROTEIA o fato pra lá, e gravar sem ter lido apagaria o que havia.
        if (slug === PERFIL) antesPor[OVERFLOW] = (await getWikiPage(userId, OVERFLOW))?.body || '';
        const res = await escreverComFatos(userId, ops, {
          paginas: antesPor, titulos: atual?.title ? { [slug]: atual.title } : {},
          fonte: { ...fonte, origem: 'memoria_anotar' }, origem: 'conversa', logTag: 'tool=memoria_anotar',
        });
        if (!res.feitas.length && res.puladas.length && res.puladas.every((x) => x.includes(':ja_existe('))) {
          return `Já estava anotado (${res.puladas.join(', ')}). Nada a gravar.`;
        }
        if (!res.feitas.length) {
          // Falha VISÍVEL (âncora que não casa, texto curto, duplicado): o modelo
          // recebe o motivo e pode tentar de novo, em vez de achar que gravou.
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
        // Guarda-corpo determinístico: a reescrita só passa se NÃO perder fato.
        // O A/B de 01/09 mostrou as duas formas de estrago (condensar e mutar) e
        // as duas aparecem aqui como linha que sai sem par. Página vazia (criação)
        // e pedido explícito do dono (substituir) seguem livres.
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

// Texto pro system prompt: a página `perfil` em cheio + índice das outras páginas.
// Desde a Fase 2 o próprio perfil já carrega a seção de links (gerada), então aqui
// só entram as páginas que ficaram FORA dessa seção, pra não pagar o índice 2x.
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
  // Chaves dos fatos vigentes: sem elas o assistente inventa uma chave nova pro
  // mesmo assunto e o fato antigo nunca é substituído.
  // R2 (MEMORIA_BUSCA_V2=1): todas as chaves, não só as 40 mais novas; fato antigo
  // fora da lista era regravado com chave nova.
  const fatos = await listCurrentFacts(userId, { limit: buscaV2Ligada() ? 400 : 40 }).catch(() => []);
  if (fatos.length) {
    lines.push(
      '',
      'Fatos com chave (quando um deles MUDAR, use memoria_atualizar com a MESMA chave):',
      // Valor longo é cortado com "…" e o ponteiro pra página: sem a marca o modelo
      // tomava o pedaço como o valor inteiro (título de dissertação saiu truncado no teste 23/09).
      ...fatos.map((f) => { const v = String(f.valor); return `• ${f.assunto} [${f.pagina}]: ${v.length > 80 ? v.slice(0, 80) + `… (completo em ${f.pagina})` : v}`; }),
    );
  }
  // Dúvidas abertas: todas listadas (o modelo precisa saber qual assunto é incerto),
  // mas só se pergunta quando a tarefa do momento depende daquele fato.
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

// ── FASE 0: detector de perda linha-a-linha ──
// Todo housekeeping compara a página ANTES e DEPOIS e loga quantas linhas
// entraram, saíram e mudaram. Existe porque as duas classes de erro medidas no
// A/B de 01/09/2026 (gemini MUTA um fato, V4 Flash CONDENSA e come linhas) são
// invisíveis no resultado: a página fica plausível, só menor. Sem esse contador,
// qualquer mudança na operação de memória é fé.
// Conteúdo das linhas só sai no log com PERFIL_DIFF_VERBOSE=1 (o perfil é dado
// pessoal; o padrão loga só os números).
const norm = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const linhasDe = (txt) => String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean);
// Linhas como estão na página (recuo e linhas em branco preservados), só sem
// espaço no fim e sem linha vazia sobrando no fim. É o que a escrita por patch
// edita: com linhasDe, qualquer op numa página achatava subitens e juntava
// blocos (visto em prod 25/09 numa página editada à mão no site).
const linhasCruas = (txt) => {
  const L = String(txt || '').split('\n').map((l) => l.trimEnd());
  while (L.length && !L[L.length - 1]) L.pop();
  return L;
};
const recuoDe = (l) => String(l || '').match(/^\s*/)[0];

// Semelhança por palavras (Jaccard). Serve pra separar "mudou" de "saiu+entrou":
// uma linha reescrita casa forte com a que saiu; uma linha perdida não casa com nada.
// Conta TODAS as palavras (inclusive as curtas): sem elas, linha curta editada
// ("treina A e B na academia" -> "...no parque") caía abaixo do corte e virava
// um falso "perdeu". O erro que importa não passar batido é a PERDA, então o
// desempate fica do lado de reportar demais, nunca de menos.
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
  // Casa cada linha que saiu com a melhor candidata que entrou: par forte = edição.
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

// ── FASE 1: escrita por PATCH ──
// O housekeeping não pede mais o texto da página: pede uma LISTA DE OPERAÇÕES e o
// servidor aplica de forma determinística. Assim condensar/mutar deixa de ser
// possível por construção (o texto antigo nunca passa pelo modelo pra voltar).
// Âncora que não casa (ou casa em duas linhas) = NO-OP + log, nunca escrita parcial.
const MAX_OPS = 5;            // teto por ciclo: perfil muda devagar
const CANONICAS = Object.keys(AREAS);

// A seção de links do perfil é GERADA (ver sincronizarLinks): fato novo entra
// ANTES dela, e ela não conta pro teto.
const iMarca = (L) => L.findIndex((l) => String(l).trimStart().startsWith(MARCA_LINKS));
// Formato EXATO das linhas que sincronizarLinks gera ("- slug — Título"). Serve
// pra separar o bloco gerado do que o dono escreveu embaixo dele.
const EH_LINK_GERADO = /^-\s+[a-z0-9-]+\s+—\s+\S/;
const fatosDe = (L) => { const i = iMarca(L); return (i < 0 ? L : L.slice(0, i)).filter((l) => String(l).trim() && !String(l).trimStart().startsWith('#')); };
// Antes da seção de links (e das linhas em branco que a separam dos fatos).
const inserirFato = (L, linha) => {
  let i = iMarca(L);
  if (i < 0) { L.push(linha); return; }
  while (i > 0 && !String(L[i - 1]).trim()) i--;
  L.splice(i, 0, linha);
};

// Acha a ÚNICA linha que a âncora identifica. Devolve {i} ou {erro}.
function acharAncora(linhas, ancora) {
  const alvo = norm(ancora);
  if (alvo.length < 8) return { erro: 'ancora_curta' };
  // Linha em branco (norm vazio) nunca é alvo: "".includes casaria com tudo.
  const ns = linhas.map((l, i) => [norm(l), i]).filter(([n]) => n);
  let hits = ns.filter(([n]) => n === alvo).map(([, i]) => i);
  if (!hits.length) hits = ns.filter(([n]) => n.includes(alvo) || alvo.includes(n)).map(([, i]) => i);
  if (!hits.length) return { erro: 'ancora_nao_encontrada' };
  if (hits.length > 1) return { erro: 'ancora_ambigua' };
  return { i: hits[0] };
}

// Aplica as operações. Puro (não toca o banco): devolve as páginas a gravar + o log.
export function aplicarOps(ops, paginas, { maxOps = MAX_OPS } = {}) {
  const out = new Map();  // slug -> array de linhas
  const linhasDoSlug = (slug) => {
    if (!out.has(slug)) out.set(slug, linhasCruas(paginas[slug] ?? ''));
    return out.get(slug);
  };
  const feitas = [], puladas = [], mudancas = [];
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, maxOps)) {
    // `fato` = índice da definição (op definir) que gerou esta op; quem grava
    // o fato usa pra saber onde a linha foi parar.
    const tag = { ...(op?._fato != null ? { fato: op._fato } : {}), ...(op?._de ? { de: op._de } : {}) };
    const tipo = String(op?.op || '').toLowerCase();
    // Nome canonico (mesma funcao que o banco usa pra gravar). Com duas regras
    // diferentes, "pessoa-joão" era lido de uma pagina e gravado noutra, e a
    // pagina existente voltava com so a linha nova (achado #18).
    let destino = normWikiSlug(op?.pagina || PERFIL);
    const existe = destino === PERFIL || Object.prototype.hasOwnProperty.call(paginas, destino)
      || CANONICAS.includes(destino) || ehPaginaDePessoa(destino);
    if (tipo === 'nada' || !tipo) { continue; }
    if (destino === ATUALIZACOES) { puladas.push(`${tipo}:pagina_reservada`); continue; }
    if (!existe) { puladas.push(`${tipo}:pagina_desconhecida(${destino})`); continue; }
    if (tipo === 'add') {
      const texto = String(op?.texto || '').replace(/\s+/g, ' ').trim();
      if (texto.length < 8) { puladas.push('add:texto_curto'); continue; }
      // TETO DO PERFIL: não corta nada. Quando o resumão já está cheio, o fato
      // novo vai pra página de área (o chamador precisa ter carregado ela, senão
      // gravar sobrescreveria conteúdo que não foi lido).
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
      // A linha corrigida fica no mesmo nível (subitem continua subitem).
      L[r.i] = recuoDe(antes) + (texto.startsWith('-') ? texto : `- ${texto}`);
      feitas.push(`fix(${destino})`);
      mudancas.push({ op: 'fix', pagina: destino, texto, antes, ...tag });
    } else if (tipo === 'remove') {
      // Só a tool `memoria_anotar` emite 'remove' (o housekeeping nunca apaga
      // sozinho). Existe pra o dono poder dizer "tira isso da memória" sem que
      // o modelo precise reescrever a página inteira pra apagar uma linha.
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
  // Devolve SÓ as páginas que de fato mudaram: quem chama grava o que vier aqui.
  const paginasNovas = {};
  for (const [slug, L] of out) {
    const body = L.join('\n');
    if (body.trim() !== String(paginas[slug] ?? '').trim()) paginasNovas[slug] = body;
  }
  return { paginas: paginasNovas, feitas, puladas, mudancas };
}

// ── MEMÓRIA v2, Fase 1: fatos com chave e vigência ──
// Fato que tem UM valor atual (onde mora, empresa, cargo, tamanho) ganha uma
// CHAVE (assunto). Escrever de novo o mesmo assunto troca a linha antiga em vez
// de acrescentar outra: é o que impede "mora em SP" e "mora em Curitiba" de
// conviverem na página. O fato vive em memory_facts; a página mostra a linha.
const MAX_FATOS_PROMPT = 80;

export function normAssunto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Aceita AAAA-MM-DD, AAAA-MM, AAAA e DD/MM/AAAA. Devolve a data (primeiro dia
// do período, pro banco) e o texto na MESMA precisão que veio (pra página não
// afirmar um dia que ninguém disse).
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

// Valor a partir de uma linha que o dono corrigiu na mão: tira o marcador e o
// sufixo que linhaDoFato acrescenta.
export function valorDaLinha(linha) {
  return limpaValor(linha).replace(/\s\((?:desde|antes:)[^()]*\)$/, '').trim();
}

// Troca `velho` por `novo` dentro da linha só quando `velho` aparece UMA vez,
// como palavra inteira (sem diferenciar maiúscula). Senão devolve null.
export function trocarNaLinha(linha, velho, novo) {
  const v = limpaValor(velho);
  if (v.length < 3) return null;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu');
  if ((String(linha).match(re) || []).length !== 1) return null;
  return String(linha).replace(re, () => limpaValor(novo));
}

// Puro. Troca cada op `definir` pelas ops de linha equivalentes (fix na linha
// que o fato já ocupa; add se é novo ou se a linha sumiu; remove+add se mudou
// de página). Devolve as ops expandidas + a lista de definições pra gravar.
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
    // Mesmo valor com data nova só completa a data; não vira "antes: ele mesmo".
    const antigo = velho && norm(velho.valor) !== norm(valor) ? velho.valor : '';
    const linha = linhaDoFato(valor, desde?.txt, antigo);
    const idx = definicoes.length;
    definicoes.push({ assunto, valor, desde: desde?.iso || null, destino, linha });
    const corpoVelho = velho ? paginas[velho.pagina] : undefined;
    const velhoNaPagina = !!(velho?.linha_pagina && corpoVelho !== undefined
      && !acharAncora(linhasDe(corpoVelho), velho.linha_pagina).erro);
    // Linha composta (ex.: a do perfil com nome, CPF e e-mail juntos, comum nos
    // fatos que vieram da migração): trocar a linha inteira apagaria o resto.
    // Troca só o valor velho dentro dela, se ele aparece uma vez só; se não dá
    // pra achar sem ambiguidade, a linha velha fica e o fato ganha linha própria.
    const composta = velhoNaPagina && norm(valorDaLinha(velho.linha_pagina)) !== norm(velho.valor);
    if (composta && velho.pagina === destino && !antigo) {
      // Mesmo valor, só a data nova: a linha fica como está.
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

// Fecha uma dúvida da memória. Nunca decide sozinho: quem chama é o dono (tool)
// ou o admin (/metrics). Depois de gravar o fato, as versões que perderam são
// tiradas das páginas (senão o assistente continua vendo as duas e a dúvida volta
// na prática). Tudo que mudou fica em `desfazer`, e a página antiga fica nas cópias.
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
    // "definir:igual" = o fato vigente já tem esse valor: a dúvida está respondida.
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

// Palavras de conteúdo (sem acento; 3+ letras ou com dígito): é com elas que a
// checagem decide se apagar uma linha perderia alguma coisa.
const palavrasDe = (s) => new Set(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 || /\d/.test(w)));

const SYS_PERDEDORA = `Uma linha da memória de uma pessoa contradiz a versão CERTA de um assunto. Troque SÓ o pedaço que contradiz: o resto da linha são outros dados, verdadeiros, e têm que ficar.
Devolva SÓ JSON {"trecho_errado":"cópia EXATA, caractere por caractere, do MENOR pedaço da linha que contradiz a versão certa","trecho_certo":"o que entra no lugar, no mesmo estilo, usando só o que a versão certa diz"}.
O trecho errado leva SÓ as palavras que a versão certa desmente. Detalhe que ela não menciona (cor de fundo, lugar, outra pessoa, outra data) não é conflito e fica.
Se a linha não contradiz a versão certa (as duas podem ser verdade juntas), devolva {"manter":true}.
Só se a linha inteira disser a mesma coisa que a versão certa, sem nenhum dado a mais, devolva {"apagar":true}.`;

// Fixes ONE losing line by swapping only the conflicting excerpt ("nothing may
// be lost"; before, the whole line was swapped and took true facts with it, e.g.
// a page lost "Algarve"). The model only points at the excerpt; the new line is
// built HERE with replace, so outside the excerpt it is the old one letter by
// letter. Delete the line only when each of its words is already in the winner.
async function corrigirPerdedora(assunto, velha, vencedora) {
  const r = await makeMemoriaModel().forBillingPhase({ kind: 'housekeeping' }).complete({
    system: SYS_PERDEDORA, tools: [],
    messages: [{ role: 'user', content: `Assunto: ${assunto}\nVersão CERTA: ${vencedora}\nLinha a corrigir: ${velha}` }],
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

// Planeja a correção de TODAS as perdedoras antes de gravar qualquer coisa: se uma
// não dá pra corrigir sem perda, a dúvida não é resolvida e nenhuma página muda.
// Linha que sustenta fato de OUTRO assunto não é tocada (o fato ficaria apontando
// pra uma linha que não existe).
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

// Aplica o plano linha a linha, guardando o índice pra desfazer achar o lugar certo.
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

// Índice da ocorrência de `alvo` mais perto de `idx` (a página pode ter mudado
// desde a resolução; o texto manda, o índice só desempata).
function acharPerto(linhas, alvo, idx) {
  let melhor = -1;
  linhas.forEach((l, i) => { if (norm(l) === norm(alvo) && (melhor < 0 || Math.abs(i - idx) < Math.abs(melhor - idx))) melhor = i; });
  return melhor;
}

// Desfaz uma resolução: devolve as linhas às páginas, desfaz a troca de fato e
// reabre a dúvida. Descartada só reabre.
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
    // De trás pra frente: desfaz na ordem inversa da aplicação.
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

// Escrita única de memória (tool e housekeeping): expande `definir`, aplica,
// grava páginas, grava fatos e mantém os fatos em dia com correções de linha
// feitas pelos caminhos antigos (fix/remove/move). `paginas` = corpos já lidos;
// as páginas que os fatos tocam são carregadas aqui.
// R1+R3 (ver wiki-reconciliar.mjs): troca cada add/definir pelo que o conciliador
// decidiu. "Já está" pula a op; "atualizar" vira definir na linha que já existe
// (linha sem fato ganha um fato sintético com o valor antigo, pra troca deixar
// histórico em memory_facts); as outras páginas que repetem o valor antigo
// ganham um fix só no trecho. Erro do modelo = a op segue como veio.
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

// O housekeeping roda depois do turno, lendo só a conversa. Se no MESMO turno
// o assistente já gravou o fato pela tool (ou o conciliador decidiu), essa
// escrita é a mais nova e explícita: o housekeeping não pode sobrescrever
// com um valor que tirou de uma mensagem mais antiga (visto em prod 25/09:
// R$619 gravado pela tool virou R$522 três segundos depois). Filtra ANTES do
// conciliador, que também grava fato direto.
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
    // Housekeeping não cria página fora da lista conhecida (igual ao add dele);
    // a tool pode, como o memoria_anotar sempre pôde.
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
        // Linha idêntica já estava na página (add:duplicado): o fato passa a apontar pra ela.
        const corpo = res.paginas[d.destino] ?? paginas[d.destino] ?? '';
        if (linhasDe(corpo).some((l) => norm(l) === norm(d.linha))) { pagina = d.destino; linha = d.linha; }
      }
      if (!pagina) { res.puladas.push(`definir:nao_gravado(${d.assunto})`); continue; }
      await setFact(userId, { pagina, assunto: d.assunto, valor: d.valor, desde: d.desde, linha, fonte: { ...fonte, origem: fonte.origem || origem } });
      gravados.push(d.assunto);
    }
    // Caminhos antigos mexendo em linha que é de um fato: o fato acompanha.
    for (const m of res.mudancas) {
      if (m.fato != null) continue;
      const alvo = m.op === 'fix' ? m.antes : m.texto;
      const pag = m.op === 'move' ? m.de : m.pagina;
      const f = fatos.find((x) => x.pagina === pag && norm(x.linha_pagina) === norm(alvo));
      if (!f) {
        // Linha sem fato corrigida ou apagada: a versão antiga vira histórico.
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
        // Linha composta: o valor do fato é só um pedaço dela. Se o pedaço
        // continua lá, só a linha muda; valor = linha inteira só pra linha simples.
        const composta = norm(valorDaLinha(f.linha_pagina)) !== norm(f.valor);
        const aindaLa = composta && norm(nova).includes(norm(f.valor));
        if (!aindaLa && historicoLigado() && norm(valorDaLinha(nova)) !== norm(f.valor)) {
          // Valor mudou na mão: encerra o fato e abre outro, em vez de sobrescrever
          // (sobrescrever apagava o valor antigo sem deixar histórico).
          await setFact(userId, { pagina: m.pagina, assunto: f.assunto, valor: valorDaLinha(nova), linha: nova, fonte: { ...fonte, origem: fonte.origem || origem } });
        } else {
          // Linha composta: o valor do fato ficou, mas outro pedaço da linha mudou.
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

// ── Seção de links do perfil (gerada, nunca escrita pelo modelo) ──
// O perfil vira o "overview" do Town: os fatos curtos + um índice das páginas de
// área. Só a seção depois do marcador é reescrita; o texto acima dela é copiado
// VERBATIM (inclusive linhas em branco), então isso nunca perde nem reformata fato.
// Parte PURA (sem banco, por isso tem teste): recebe o corpo atual do perfil e a
// lista de páginas, devolve o corpo com a seção de links refeita, ou null se a
// troca perderia alguma linha que não é do bloco gerado.
export function montarPerfilComLinks(antes, outras) {
  const cru = String(antes || '').split('\n');
  const i = iMarca(cru);
  const fatos = i < 0 ? cru.slice() : cru.slice(0, i);
  while (fatos.length && !fatos[fatos.length - 1].trim()) fatos.pop();
  // Só o BLOCO GERADO sai daqui: o marcador e as linhas no formato exato que
  // esta função escreve. O que vier depois é do dono e é copiado verbatim.
  // Antes o corte era "tudo abaixo do marcador", então qualquer coisa escrita
  // sob a seção de links sumia a cada escrita de memória (achado #17).
  let j = i < 0 ? -1 : i + 1;
  while (j >= 0 && j < cru.length && (!cru[j].trim() || EH_LINK_GERADO.test(cru[j].trim()))) j++;
  const rabo = j < 0 ? [] : cru.slice(j);
  while (rabo.length && !rabo[0].trim()) rabo.shift();
  while (rabo.length && !rabo[rabo.length - 1].trim()) rabo.pop();
  const secao = (outras || []).length
    ? ['', `${MARCA_LINKS} (leia com memoria_ler quando a tarefa pedir)`, ...outras.map((p) => `- ${p.slug} — ${p.title || tituloDe(p.slug)}`)]
    : [];
  const body = [...fatos, ...secao, ...(rabo.length ? ['', ...rabo] : [])].join('\n');
  // Trava de segurança: esta função é automática e roda depois de TODA escrita,
  // então ela nunca pode ser o motivo de uma linha sumir. Se sobrar perda que
  // não seja do bloco gerado, o chamador não grava nada.
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
    console.error(`[memoria links] u=${String(userId).slice(0, 8)} abortado: a sincronização perderia linha do perfil`);
    return false;
  }
  if (body.trim() === antes.trim()) return false;
  await upsertWikiPage(userId, { slug: PERFIL, title: perfil?.title || 'Perfil', body });
  return true;
}

// ── "Atualizações recentes" (o box que o Town mostra) ──
// Gerada de graça a partir das operações que o servidor JÁ aplicou: zero chamada
// de modelo, zero chance de inventar. É um LOG (os fatos vivem nas páginas), então
// aqui sim tem teto de entradas.
export async function registrarAtualizacao(userId, mudancas, origem = '') {
  const lista = (Array.isArray(mudancas) ? mudancas : []).filter((m) => m?.pagina);
  if (!lista.length) return false;
  const quando = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
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

// Chamada depois de toda escrita de memória: registra o que mudou e refaz os
// links do perfil. Nunca deixa um erro daqui derrubar a escrita que já aconteceu.
async function posEscrita(userId, mudancas, origem) {
  try { await registrarAtualizacao(userId, mudancas, origem); } catch (e) { console.error('[memoria atualizacoes]', e?.message ?? e); }
  try { await sincronizarLinks(userId); } catch (e) { console.error('[memoria links]', e?.message ?? e); }
}

// Valores concretos do texto (link, domínio, e-mail, número de 4+ dígitos) que não
// aparecem na fonte. Compara sem caixa, sem barra final e com dígitos colados
// ("(11) 98765-4321" casa com "11987654321").
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

// Virou função por causa do idioma: a memória é DADO DURÁVEL, fica gravada e
// volta pro prompt em todo turno futuro. Deixar a língua dela na sorte de uma
// diretriz mole significaria memória em português na conta de quem não fala
// português, pra sempre. Em pt-BR a tag rende 'pt-BR' e o texto sai byte a byte
// igual ao de antes.
const sysPatch = (language) => [
  'Você mantém a MEMÓRIA de longo prazo de um usuário de assistente pessoal.',
  'Recebe a memória atual e a última troca de mensagens. Devolve APENAS operações de escrita, em JSON.',
  '',
  'Formato (JSON puro, sem markdown, sem comentários):',
  '{"ops":[{"op":"definir","pagina":"perfil","assunto":"cidade_onde_mora","valor":"Mora em Curitiba","desde":"2026-09"},{"op":"add","pagina":"preferencias","texto":"..."},{"op":"fix","pagina":"perfil","ancora":"trecho literal da linha que está errada","texto":"linha corrigida inteira"}]}',
  'Se não há nada durável pra guardar (o caso MAIS COMUM), devolva {"ops":[]}.',
  '',
  'Regras:',
  '- Guarde só fato DURÁVEL e útil: preferências, contexto (profissão, rotina), objetivos recorrentes, restrições, tamanhos/marcas, decisões tomadas.',
  '- NUNCA guarde conversa fiada, pergunta pontual, resultado de uma tarefa, nem nada efêmero.',
  '- NUNCA inclua instruções de TOM/VOZ/ESTILO/FORMATAÇÃO do assistente (ex: "seja formal", "responde curto"). Isso é por-assistente e vazaria pros outros assistentes da pessoa. A memória é só sobre QUEM o usuário é.',
  '- Fato que tem UM valor atual e pode mudar (onde mora, empresa, cargo, tamanho, objetivo principal, plano/assinatura) = "definir", com uma chave curta e estável em snake_case (assunto). Se o assunto JÁ está na lista de fatos com chave, reuse EXATAMENTE aquela chave: o servidor troca a linha antiga sozinho.',
  '- "desde" só quando a conversa diz quando começou (AAAA-MM-DD, AAAA-MM ou AAAA). Nunca invente data; sem data, omita o campo.',
  '- Fato que só se acumula (gosta de X, já viajou pra Y) = "add".',
  '- Use "fix" só quando a troca CONTRADIZ uma linha já anotada que NÃO está na lista de fatos com chave. A âncora tem que ser um trecho literal de UMA linha existente.',
  '- Registro contável e datado (comi, treinei, gastei), plano/jornada em andamento e dado de app NÃO são memória: não guarde.',
  '- Nunca reescreva a página inteira e nunca resuma o que já está lá. Uma operação = um fato.',
  '- Todo link, e-mail, telefone, código ou número que você gravar tem que estar ESCRITO na troca ou na memória atual. Se a pessoa disse que algo mudou mas não disse o valor novo (ex: "mudei o link" sem o link), não grave nada: nunca complete com um valor provável.',
  `- Uma linha por fato, curta, em ${tagIdioma(language)}. No máximo 3 operações.`,
  '',
  'Onde guardar:',
  `- "perfil" é o RESUMÃO: só o que define a pessoa e serve em quase toda conversa (no máximo ~${PERFIL_MAX} fatos).`,
  `- Detalhe vai pra página de área: ${Object.keys(AREAS).join(', ')}.`,
  '- Fato sobre uma PESSOA específica vai numa página por pessoa, no formato "pessoa-nome" (ex: "pessoa-ana").',
  '- Se o perfil já estiver no teto, o servidor manda o fato pra "notas" sozinho; prefira já escolher a página certa.',
].join('\n');

// Manutenção da memória por PATCH (padrão). Devolve {usage, ops, feitas, puladas}.
// `dryRun` roda tudo menos a gravação (usado nos evals de memória, read-only).
export async function patchUserProfile(userId, userMsg, assistantMsg, { dryRun = false, language = null, fonte = {} } = {}) {
  const todas = await listWikiPages(userId);
  const perfilBody = (await getWikiPage(userId, PERFIL))?.body || '';
  const outras = todas.filter((p) => p.slug !== PERFIL).map((p) => p.slug);
  const fatos = await listCurrentFacts(userId, { limit: MAX_FATOS_PROMPT });
  const prompt = [
    `Memória atual (página "perfil"):\n${perfilBody.trim() || '(vazia)'}`,
    outras.length ? `\nOutras páginas existentes (destinos válidos): ${outras.join(', ')}` : '',
    fatos.length ? `\nFatos com chave (assunto [página]: valor atual):\n${fatos.map((f) => `- ${f.assunto} [${f.pagina}]: ${String(f.valor).slice(0, 120)}`).join('\n')}` : '',
    `\nÚltima troca:\nUsuário: ${userMsg}\nAgente: ${assistantMsg}`,
  ].join('\n');
  const r = await makeMemoriaModel().forBillingPhase({kind:'housekeeping'}).complete({
    system: sysPatch(language), messages: [{ role: 'user', content: prompt }], tools: [],
  });
  const bruto = (r.text || '').trim();
  let ops = null;
  try {
    const m = bruto.match(/\{[\s\S]*\}/);           // tolera cerca de markdown
    ops = m ? JSON.parse(m[0])?.ops : null;
  } catch { ops = null; }
  if (!Array.isArray(ops)) {
    // Falha VISÍVEL: não escreve nada. A memória fica como estava e o próximo
    // ciclo tenta de novo (o fato ainda está no history).
    console.log(`[perfil patch] u=${String(userId).slice(0, 8)} json_invalido len=${bruto.length}`);
    return { usage: r.usage, ops: [], feitas: [], puladas: ['json_invalido'] };
  }
  if (!ops.length) return { usage: r.usage, ops, feitas: [], puladas: [] };

  // Portão sem modelo: valor concreto (link, e-mail, número de 4+ dígitos) que não
  // está escrito na troca nem na memória foi inventado. Em 24/09 o eval pegou
  // "mudei o link" sem link virar um endereço plausível gravado como atual.
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
    // Destino perfil + teto batido = o fato é ROTEADO pra página de overflow;
    // ela precisa estar carregada pra gravação não sobrescrever o que já existe.
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

// Manutenção automática por turno da página `perfil` (camada usuário, por pessoa).
// Desde 02/09/2026 o padrão é PATCH (acima); `PERFIL_MODO=rewrite` volta pro
// comportamento antigo de reescrita sem precisar de deploy.
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
    'Você mantém um PERFIL curto e estável do usuário de um assistente pessoal.',
    'Guarde só fatos duradouros e úteis: preferências, contexto (profissão, família, rotina), objetivos recorrentes, restrições, tamanhos/marcas e decisões tomadas.',
    `NÃO guarde conversa fiada, perguntas pontuais nem nada efêmero. Máximo ~12 linhas, bullets curtos, em ${tagIdioma(language)}.`,
    'NÃO inclua instruções de TOM/VOZ/ESTILO/FORMATAÇÃO de como o assistente deve escrever ou se portar (ex: "seja formal", "responde curto", "sem emoji"). Isso é configurado por-assistente em outro lugar e vazaria pros outros assistentes do usuário se entrasse aqui. Este perfil é só sobre QUEM o usuário é.',
    'Devolva o perfil ATUALIZADO inteiro (perfil atual + o que aprendeu agora, sem duplicar). Só o perfil, sem comentários.',
  ].join('\n');
  const prompt = `Perfil atual:\n${atual.trim() || '(vazio)'}\n\nNova troca:\nUsuário: ${userMsg}\nAgente: ${assistantMsg}`;
  try {
    // Housekeeping: extração de fatos não precisa de raciocínio caro -> zera
    // o pensamento (que dominava o custo desta chamada por turno).
    const r = await makeMemoriaModel().forBillingPhase({kind:'housekeeping'}).complete({
      system: sys, messages: [{ role: 'user', content: prompt }], tools: [],
    });
    const novo = r.text?.trim();
    if (novo && novo !== atual.trim()) {
      await upsertWikiPage(userId, { slug: PERFIL, title: 'Perfil', body: novo });
      logDiffPerfil(userId, PERFIL, atual, novo, 'modo=rewrite');
    }
    // Devolve o usage pra quem chamou gravar o custo (kind='housekeeping').
    return { usage: r.usage };
  } catch {
    // se falhar, mantém o perfil que já tinha
    return null;
  }
}
