// ── Edição de planilha POR CÓDIGO (caminho de ESCRITA) ──
//
// Por que este módulo existe. Até aqui a planilha só tinha caminho de escrita
// "reescreve do zero": `gerar_documento` recebia a TABELA INTEIRA em markdown
// num argumento de tool e montava o .xlsx. Numa conversa real de 09/09/2026 a
// matriz da usuária passou dos 99 mil caracteres, bateu no limitador de blob da
// janela recente (core-proto/core.mjs, capRecentBlob, TURN_RECENT_MAX) e, na
// regeneração seguinte, o modelo reconstruiu o arquivo a partir da PRÓPRIA
// chamada anterior já truncada: a planilha caiu de 62 linhas / 18 fontes para
// 21 linhas, e o marcador de corte foi escrito como LINHA DE DADOS dentro do
// xlsx. Subir o teto do limitador só adia isso.
//
// A correção é estrutural: o conteúdo da planilha nunca mais passa pelo contexto
// do modelo pra ser editado. A planilha canônica vem da biblioteca (S3), é
// gravada no sandbox do usuário, um SUB-AGENTE a muta com openpyxl (dados crus
// morrem no worker) e os bytes voltam por `sandboxReadBytes`. O agente principal
// só vê um resumo do que mudou.
//
// Três invariantes que este módulo tem que preservar:
//  1. Cada geração é um ASSET NOVO no S3, nunca um overwrite. Foi exatamente
//     essa propriedade que permitiu recuperar as 13 versões da usuária depois do
//     incidente. A versão nova fica com o nome canônico; a que era canônica é
//     RENOMEADA pra `nome_aaaammddhhmmss.ext` (só o caption no banco muda — os
//     bytes de nenhuma versão são tocados).
//  2. Atomicidade: script que falha (ou arquivo que volta corrompido) não gera
//     asset e não encosta no Drive. O erro volta pro modelo decidir. Quando o
//     erro é SILENCIOSO (xlsx válido, mas conteúdo perdido), a edição é REFEITA
//     a partir dos bytes originais — não se entrega arquivo ruim nem se manda o
//     usuário "olhar a versão anterior": ou a mudança sai certa, ou nada muda.
//  3. Serialização por usuário: turnos encavalados ("acrescenta 4 linhas" e, antes
//     de terminar, "corrige o ano do ART-07") rodariam dois sub-agentes contra o
//     MESMO arquivo, e o segundo recarregaria a cópia do S3 por cima do trabalho
//     do primeiro — perda silenciosa de edição. A fila abaixo resolve.

import { sheetSandboxPath } from './planilha.mjs';

// ── Lógica pura (testável offline, sem banco e sem sandbox) ──

// Marcador que o capRecentBlob injeta no meio de um blob cortado. Se ele aparece
// num conteúdo que o modelo está mandando ESCREVER, o modelo está copiando a
// própria chamada truncada — foi o mecanismo do incidente de 09/09/2026.
export const CUT_MARKER_RE = /…\[cortado: ?\d+ chars\]…/;

export function hasCutMarker(s) {
  return typeof s === 'string' && CUT_MARKER_RE.test(s);
}

// Tentativas do sub-agente por edição. 2 = a original + uma refeita com o
// diagnóstico do que saiu errado. Só a 2ª custa token, e só quando a 1ª errou.
const MAX_TENTATIVAS = 2;

const SHEET_EXT_RE = /\.(xlsx|xlsm)$/i;
const SHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);

export function isSheetAsset(a) {
  if (!a) return false;
  if (SHEET_MIMES.has(String(a.mime || '').toLowerCase())) return true;
  return SHEET_EXT_RE.test(String(a.caption || ''));
}

// Picks WHICH asset to edit. Without an explicit id, the newest spreadsheet:
// older ones are version history (decided 09/09/2026).
// `assets` comes from listMediaAssets, already ordered by created_at DESC.
export function pickSheetAsset(assets, { id = null } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  if (id != null && String(id).trim() !== '') {
    const found = list.find((a) => String(a.id) === String(id));
    if (!found) return { error: 'Não achei esse arquivo na biblioteca.' };
    if (!isSheetAsset(found)) return { error: `O arquivo ${id} ("${found.caption || 'sem nome'}") não é uma planilha .xlsx.` };
    return { asset: found };
  }
  const found = list.find(isSheetAsset);
  if (!found) return { error: 'Não achei nenhuma planilha na biblioteca deste usuário. Gere a planilha primeiro (gerar_documento com formato xlsx) e depois edite.' };
  return { asset: found };
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Nome da versão ARQUIVADA: `nome_aaaammddhhmmss.ext`, com o timestamp de criação
// da própria versão (não o de agora) — assim o histórico fica ordenável e o nome
// diz quando aquele conteúdo nasceu. Sem data utilizável, cai pra `_v` + id.
export function versionedCaption(caption, createdAt, { id = null } = {}) {
  const raw = String(caption || 'planilha.xlsx');
  const m = raw.match(SHEET_EXT_RE);
  const ext = m ? m[0] : '';
  const base = ext ? raw.slice(0, -ext.length) : raw;
  const d = createdAt instanceof Date ? createdAt : (createdAt ? new Date(createdAt) : null);
  if (!d || Number.isNaN(d.getTime())) return `${base}_v${id ?? 'antiga'}${ext}`;
  const stamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return `${base}_${stamp}${ext}`;
}

// Fila por chave: garante que duas edições do mesmo usuário nunca rodem
// sobrepostas. Cada chamada espera a anterior TERMINAR (inclusive quando ela
// falha) e só então roda — é o que faz "sempre recarregar do S3" ser correto,
// porque a segunda edição já pega o asset que a primeira acabou de gravar.
const chains = new Map(); // key -> Promise da última operação enfileirada

export function withKeyLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // roda mesmo que a anterior tenha rejeitado
  // Mantém a corrente viva mas sem vazar rejeição pra fora do enfileiramento.
  const tail = next.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

// Resumo determinístico do que mudou nas DIMENSÕES do arquivo (linhas/abas). É
// contado dos bytes, não da narrativa do sub-agente: se ele disser "acrescentei
// 4 linhas" e o arquivo tiver perdido 40, isto aparece.
export function describeDelta(before, after) {
  const parts = [];
  const b = before || {}, a = after || {};
  if (a.rows != null && b.rows != null && a.rows !== b.rows) {
    const d = a.rows - b.rows;
    parts.push(`linhas ${b.rows} → ${a.rows} (${d > 0 ? '+' : ''}${d})`);
  } else if (a.rows != null) {
    parts.push(`linhas ${a.rows} (sem mudança na contagem)`);
  }
  if (a.sheets != null && b.sheets != null && a.sheets !== b.sheets) {
    parts.push(`abas ${b.sheets} → ${a.sheets}`);
  } else if (a.sheets != null) {
    parts.push(`${a.sheets} aba(s)`);
  }
  return parts.join(', ');
}

// Palavra que o sub-agente escreve no resumo pra confirmar que a planilha
// encolheu DE PROPÓSITO (a instrução pedia remoção). Sem ela, encolhimento
// grande é tratado como erro e a edição é refeita.
export const DECLARACAO_REMOCAO = 'REMOCAO_INTENCIONAL';

export function declarouRemocao(resumo) {
  const s = String(resumo || '').toUpperCase();
  return s.includes('REMOCAO_INTENCIONAL') || s.includes('REMOÇÃO_INTENCIONAL');
}

// ── Fidelidade de round-trip: as PEÇAS internas do arquivo ──
//
// Um .xlsx é um ZIP. Gráfico, imagem, tabela dinâmica e macro são PEÇAS
// separadas (xl/charts/, xl/media/, xl/pivotCache/, xl/vbaProject.bin). Quando um
// script recria o arquivo — ou quando a lib não entende a peça — ela simplesmente
// DESAPARECE do zip, sem erro nenhum. Comparar a lista de peças antes/depois pega
// essa classe inteira de dano, incluindo recursos que eu não consigo testar aqui
// (tabela dinâmica, macro, slicer), sem precisar prever cada um.
//
// A política é de dois níveis porque um nível só quebraria a ferramenta:
//  • peça de CONTEÚDO perdida = ERRO (refaz; se insistir, não grava). Medido:
//    sem Pillow instalado, o openpyxl apaga xl/drawings/* e xl/media/* EM
//    SILÊNCIO — é exatamente esse caso.
//  • peça ACESSÓRIA perdida = só AVISO. Medido num .xlsx real saído do Excel: o
//    round-trip perde customXml/* (9 peças), docMetadata/LabelInfo.xml (rótulo
//    de sensibilidade) e xl/sharedStrings.xml (o openpyxl grava string inline —
//    não é perda de conteúdo). Tratar isso como erro deixaria qualquer planilha
//    vinda do Excel impossível de editar.
const PECA_ACESSORIA_RE = new RegExp([
  '^customxml/',                            // XML customizado do Office
  '^docmetadata/',                          // rótulo de sensibilidade (MIP)
  '^docprops/',                             // autor, título, tempo de edição
  '^xl/sharedstrings\\.xml$',               // openpyxl grava string inline
  '^xl/calcchain\\.xml$',                   // cache de ordem de cálculo (Excel refaz)
  '^xl/metadata\\.xml$',
  '^xl/richdata/', '^xl/rdrichvalue',       // tipos de dado ricos
  '^xl/threadedcomments/', '^xl/persons/',  // comentário com thread
  '^xl/revisions/', '^xl/usernames\\.xml$',
].join('|'), 'i');

// Peças que existiam no original e não existem no arquivo salvo, separadas por
// gravidade. Sem lista de peças nos dois lados, não opina.
export function pecasPerdidas(before, after) {
  const b = Array.isArray(before?.parts) ? before.parts : null;
  const a = Array.isArray(after?.parts) ? after.parts : null;
  if (!b || !a) return { conteudo: [], acessorias: [] };
  const tem = new Set(a.map((n) => String(n).toLowerCase()));
  const conteudo = [], acessorias = [];
  for (const n of b) {
    if (tem.has(String(n).toLowerCase())) continue;
    (PECA_ACESSORIA_RE.test(String(n)) ? acessorias : conteudo).push(n);
  }
  return { conteudo, acessorias };
}

// Falha SILENCIOSA: o script rodou sem erro e salvou um xlsx VÁLIDO, e ainda
// assim o resultado está errado (recriou o arquivo em vez de editar, salvou em
// outro caminho, escreveu conteúdo truncado). Nenhuma verificação técnica pega
// isso — a única defesa é medir o arquivo e comparar com o de antes.
// Devolve null quando está bom, ou { motivo, instrucao } pra REFAZER a edição.
export function detectarProblema({ before, after, resumo, identical = false }) {
  if (identical) {
    return {
      motivo: 'o arquivo voltou byte a byte idêntico ao original: nada foi alterado',
      instrucao: 'Você salvou no MESMO caminho que recebeu? Reabra o arquivo, aplique a mudança e salve exatamente nesse caminho.',
    };
  }
  if (hasCutMarker(after?.text)) {
    return {
      motivo: 'a planilha contém o marcador de corte "…[cortado: N chars]…" como DADO dentro de uma célula',
      instrucao: 'Isso é texto truncado escrito na planilha. Apague essas células/linhas e aplique a mudança sobre o conteúdo real do arquivo.',
    };
  }
  const perdidas = pecasPerdidas(before, after);
  if (perdidas.conteudo.length) {
    return {
      motivo: `o arquivo salvo perdeu ${perdidas.conteudo.length} peça(s) interna(s) que existiam no original: ${perdidas.conteudo.slice(0, 6).join(', ')}`,
      instrucao: 'Isso é gráfico, imagem, tabela dinâmica ou macro que DESAPARECEU do arquivo — sinal de que ele foi recriado em vez de editado, ou de que faltou uma dependência da lib. Instale Pillow junto do openpyxl (sem Pillow o openpyxl apaga as imagens em silêncio), abra o original com load_workbook SEM data_only, mude só o que a instrução pede e salve no mesmo caminho. Planilha .xlsm com macro: use keep_vba=True.',
    };
  }
  const bf = Number(before?.formulas), af = Number(after?.formulas);
  if (Number.isFinite(bf) && Number.isFinite(af) && bf >= 5 && af < bf * 0.7 && !declarouRemocao(resumo)) {
    return {
      motivo: `as fórmulas da planilha viraram valores estáticos (${bf} → ${af} fórmulas)`,
      instrucao: 'Você abriu a planilha com load_workbook(..., data_only=True). Isso descarta TODAS as fórmulas e grava só o último valor que o Excel havia calculado. Abra SEM data_only e refaça. Se precisar do valor calculado pra alguma conta, abra uma SEGUNDA cópia com data_only=True só pra ler, e salve sempre a primeira.',
    };
  }
  const b = Number(before?.rows) || 0, a = Number(after?.rows) || 0;
  if (b >= 10 && a < b * 0.7 && !declarouRemocao(resumo)) {
    return {
      motivo: `a planilha encolheu de ${b} para ${a} linhas`,
      instrucao: `A instrução não pedia remoção em massa — você provavelmente recriou o arquivo em vez de editá-lo no lugar. Refaça preservando TODAS as ${b} linhas que já existiam. Se a remoção REALMENTE era o que a instrução pedia, escreva a palavra ${DECLARACAO_REMOCAO} no seu resumo pra confirmar que foi de propósito.`,
    };
  }
  return null;
}

// ── Canal de dúvida: o sub-agente pode perguntar em vez de adivinhar ──
//
// "Atualiza a coluna de status" numa planilha com três abas e duas colunas
// parecidas é ambíguo. Chutar a interpretação errada gera uma versão nova
// plausível e ERRADA — o pior desfecho possível, porque o usuário não tem como
// saber. Com esta sentinela o sub-agente devolve a PERGUNTA, nada é gravado e
// quem decide é o usuário.
export const SENTINELA_CLARIFICACAO = 'PRECISO_DE_CLARIFICACAO';

export function pedeClarificacao(resumo) {
  const m = String(resumo || '').match(/PRECISO[_ ]DE[_ ]CLARIFICA[CÇ][AÃ]O\s*:?\s*([\s\S]*)/i);
  if (!m) return null;
  const pergunta = String(m[1] || '').split(/\r?\n\s*\r?\n/)[0].trim();
  return pergunta || 'O editor precisou de mais detalhes pra aplicar a mudança, mas não disse quais.';
}

// ── Evidência de célula: conferência do CONTEÚDO, do lado de fora ──
//
// As checagens acima são dimensionais (linhas, abas, peças, fórmulas): pegam
// arquivo destruído, não pegam mudança feita no lugar errado. Então o sub-agente
// DECLARA as células que mudou ("EVIDENCIA: Artigos!C8=2019") e o orquestrador
// relê exatamente essas células dos bytes SALVOS pra confirmar. Custa ~nada de
// token (só as refs voltam ao contexto, nunca a planilha) e transforma "o
// sub-agente disse que fez" em "está no arquivo".
const MAX_EVIDENCIAS = 20;
const REF_A1_RE = /^(?:'?[^!']+'?!)?\$?[A-Za-z]{1,3}\$?\d{1,7}$/;

export function parseEvidencia(resumo, { max = MAX_EVIDENCIAS } = {}) {
  const out = [];
  for (const linha of String(resumo || '').split(/\r?\n/)) {
    const m = linha.match(/^\s*[-•*]?\s*EVID[EÊ]NCIAS?\s*:\s*(.+)$/i);
    if (!m) continue;
    for (const item of m[1].split(/\s*[;|]\s*/)) {
      const p = item.match(/^([^=]+?)\s*=\s*([\s\S]*)$/);
      if (!p) continue;
      const ref = p[1].trim().replace(/^[`"']+|[`"']+$/g, '');
      if (!REF_A1_RE.test(ref)) continue;
      const esperado = p[2].trim().replace(/^[`"“]+|[`"”]+$/g, '');
      out.push({ ref, esperado });
      if (out.length >= max) return out;
    }
  }
  return out;
}

function normTexto(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Candidatos numéricos de um valor declarado em português ("1.234,56", "R$ 80",
// "15%"). Percentual devolve dois candidatos porque não há como saber se o
// declarado é a fração armazenada (0.15) ou a aparência formatada (15%).
function numerosDe(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? [v] : [];
  let s = String(v ?? '').trim();
  if (!s) return [];
  const pct = /%$/.test(s);
  s = s.replace(/^(r\$|us\$|\$|€|£)\s*/i, '').replace(/%$/, '').trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/\s/g, '');
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return [];
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return [];
  return pct ? [n / 100, n] : [n];
}

function pareceData(s) {
  return /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/.test(String(s || ''))
    || /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/i.test(String(s || ''));
}

// Compara o que o sub-agente declarou com o que está gravado. Conservadora de
// propósito: só acusa erro quando a célula está claramente diferente, não existe
// ou está em aba inexistente. Caso duvidoso (data virou número de série, célula
// é fórmula ainda não calculada) entra em `naoVerificaveis` — vira aviso, não
// motivo pra jogar fora uma edição provavelmente correta.
export function conferirEvidencia(evidencias, lidas) {
  const porRef = new Map((lidas || []).map((c) => [String(c.ref), c]));
  const erros = [], naoVerificaveis = [];
  let conferidas = 0;
  for (const ev of evidencias || []) {
    const cel = porRef.get(ev.ref);
    if (!cel || cel.invalid) { naoVerificaveis.push(`${ev.ref} (não consegui reler essa referência)`); continue; }
    if (cel.noSheet) { erros.push(`${ev.ref}: essa aba não existe no arquivo salvo`); continue; }
    if (!cel.exists) { erros.push(`${ev.ref}: célula VAZIA no arquivo salvo, mas você declarou "${ev.esperado}"`); continue; }

    // Fórmula declarada: o openpyxl não recalcula, então o valor fica vazio —
    // o que se confere é o TEXTO da fórmula.
    if (/^=/.test(ev.esperado)) {
      const gravada = cel.formula ? `=${cel.formula}` : '';
      if (normTexto(gravada.replace(/\s+/g, '')) === normTexto(ev.esperado.replace(/\s+/g, ''))) conferidas++;
      else if (!cel.formula) erros.push(`${ev.ref}: você declarou a fórmula ${ev.esperado}, mas a célula salva não tem fórmula`);
      else erros.push(`${ev.ref}: a fórmula salva é =${cel.formula}, você declarou ${ev.esperado}`);
      continue;
    }
    if (cel.formula && !String(cel.value || '')) {
      naoVerificaveis.push(`${ev.ref} (é fórmula: o valor só existe depois de o Excel recalcular)`);
      continue;
    }

    const esp = numerosDe(ev.esperado), got = numerosDe(cel.value);
    if (esp.length && got.length) {
      const bate = esp.some((x) => got.some((y) => Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-9)));
      if (bate) conferidas++;
      else erros.push(`${ev.ref}: valor salvo ${cel.value}, você declarou ${ev.esperado}`);
      continue;
    }
    // Data gravada como número de série do Excel vs declarada como texto (ou o
    // contrário): correto, mas incomparável aqui.
    if (esp.length !== got.length && (pareceData(ev.esperado) || pareceData(cel.value))) {
      naoVerificaveis.push(`${ev.ref} (data: declarada "${ev.esperado}", gravada como "${cel.value}")`);
      continue;
    }
    const a = normTexto(ev.esperado), b = normTexto(cel.value);
    if (a === b || (a && b && (b.includes(a) || a.includes(b)))) conferidas++;
    else erros.push(`${ev.ref}: valor salvo "${cel.value}", você declarou "${ev.esperado}"`);
  }
  return { total: (evidencias || []).length, conferidas, erros, naoVerificaveis };
}

// ── Prompt do sub-agente EDITOR ──

export const SHEET_EDITOR_SYSTEM = `Você é um sub-agente EDITOR DE PLANILHAS. Recebe UMA planilha Excel JÁ GRAVADA num caminho do /workspace do ambiente isolado e uma instrução de mudança em linguagem natural. Sua tarefa é APLICAR a mudança no arquivo, por CÓDIGO, e devolver só um RESUMO do que mudou.

Regras (siga à risca):
• EDITE O ARQUIVO NO LUGAR. Abra com openpyxl, altere e salve NO MESMO CAMINHO que você recebeu. NUNCA recrie a planilha do zero e NUNCA escreva num arquivo novo: as abas, linhas, fórmulas e formatações que a instrução não menciona têm que continuar exatamente como estão. A planilha é do USUÁRIO e pode ter gráfico, imagem, fórmula, formatação condicional, validação, filtro e painel congelado — tudo isso tem que sobreviver.
• Se faltar openpyxl: sandbox_shell "pip install --break-system-packages --target=/workspace/.pylibs openpyxl Pillow" e, no python, sys.path.insert(0, '/workspace/.pylibs') antes do import. Instale Pillow SEMPRE junto: sem ele o openpyxl APAGA as imagens da planilha em silêncio, e a edição é rejeitada por perda de conteúdo. (O rootfs é só-leitura; instalar no sistema não funciona.)
• NUNCA abra com load_workbook(..., data_only=True) pra salvar: isso apaga TODAS as fórmulas e grava só o último valor calculado. Se precisar do valor calculado pra fazer uma conta, abra uma SEGUNDA cópia com data_only=True apenas pra LER, e salve sempre a primeira. Arquivo .xlsm: load_workbook(..., keep_vba=True), senão a macro morre.
• ANTES de mudar qualquer coisa, INSPECIONE: liste as abas (wb.sheetnames), o cabeçalho e o número de linhas de cada uma (ws.max_row), e localize por CÓDIGO a linha/coluna que a instrução aponta (procure pelo valor da célula; não conte linhas "de olho"). Imprima o que achou.
• FORMATO DA CÉLULA: linha nova nasce com formato "General". Ao acrescentar linhas, COPIE o number_format (e alinhamento, se houver) da célula equivalente da última linha existente, coluna por coluna — senão a coluna fica mista e some/ordenação quebram. Datas: grave objeto datetime, não string. Dinheiro/percentual: grave número (0.15, não "15%") e deixe o number_format cuidar da aparência.
• DEPOIS de salvar, REABRA o arquivo e imprima a conferência: abas, ws.max_row por aba, e as linhas que você tocou. Se o número de linhas caiu sem que a instrução pedisse remoção, você errou: conserte antes de responder.
• Se a instrução PEDIA remoção e a planilha encolheu de propósito, escreva a palavra REMOCAO_INTENCIONAL no seu resumo. Sem ela, encolhimento grande é tratado como erro e a edição é refeita do zero.
• NÃO faça contas de cabeça. Qualquer total, contagem ou média sai do código.
• Se a instrução for ambígua mas UMA interpretação for claramente a mais razoável, siga ela e DIGA a premissa que assumiu. Se a ambiguidade for de verdade (duas abas servem, não se sabe qual coluna, o valor não bate com nada no arquivo), NÃO adivinhe e NÃO salve: responda com a linha "${SENTINELA_CLARIFICACAO}: <a pergunta que resolve>" e pare. Idem se for impossível (aba/coluna não existe, arquivo ilegível): diga objetivamente o que faltou.
• EVIDÊNCIA (obrigatória): no resumo, declare as células que você mudou e o valor que ficou nelas, uma por linha, no formato exato:
EVIDENCIA: Aba!C8=1234,50
Use no máximo 20 (as mais representativas se mudou muita coisa). Fórmula: declare o texto da fórmula, começando com = (ex.: EVIDENCIA: Resumo!D2==SOMA(B2:B10)). Essas células são RELIDAS do arquivo salvo por código: se o que você declarou não estiver lá, a edição é refeita. Não invente evidência — declare só o que você conferiu reabrindo o arquivo.
• RESPOSTA FINAL: só o RESUMO da mudança — o que mudou, em qual aba, quantas linhas foram afetadas, as premissas e as linhas EVIDENCIA. NÃO cole o conteúdo da planilha, NÃO liste as linhas todas, NÃO devolva tabela: o conteúdo da planilha não pode voltar pro agente principal. Máximo ~10 linhas de texto além das evidências.`;

// ── Orquestração ──
//
// Todas as dependências entram por parâmetro (`deps`) pra este fluxo poder ser
// testado offline, sem banco, sem S3 e sem sandbox — o que inclui os caminhos
// que importam: falha do script (nenhum asset gravado) e edições encavaladas
// (a segunda parte do arquivo que a primeira gravou).
//
// deps:
//   listAssets(userId, { limit })   -> [asset]
//   getAsset(userId, id)            -> asset | null
//   fetchBytes(s3Key)               -> { buffer, contentType }
//   loadIntoSandbox(userId, buffer, filename) -> { ok, path, filename, sheets, rows }
//   readBytes(userId, path)         -> { ok, buffer } | { ok:false, error }
//   inspect(buffer)                 -> { sheets, rows, text, parts?, formulas? }  (lança se corrompido)
//   readCells(buffer, refs)         -> [{ ref, exists, value, formula, ... }]  (opcional)
//   runEditor({ objetivo, path, filename, sheets, rows, tentativa }) -> string
//   saveAsset({ buffer, ext, mime, caption }) -> { url, key, assetId }
//   renameAsset(userId, id, caption) -> boolean
export async function editSpreadsheet({ userId, objetivo, id = null, deps }) {
  if (!objetivo || !String(objetivo).trim()) return { ok: false, error: 'objetivo vazio.' };
  // Serializa por USUÁRIO (não por arquivo): a escolha do asset acontece DENTRO
  // do lock, então a segunda edição enxerga a versão que a primeira gravou.
  return withKeyLock(`sheet:${userId}`, () => editOnce({ userId, objetivo, id, deps }));
}

async function editOnce({ userId, objetivo, id, deps }) {
  const assets = id != null && String(id).trim() !== ''
    ? [await deps.getAsset(userId, id)].filter(Boolean)
    : await deps.listAssets(userId, { limit: 40 });
  const pick = pickSheetAsset(assets, { id });
  if (pick.error) return { ok: false, error: pick.error };
  const asset = pick.asset;

  // Sempre recarrega do S3: o registro de planilhas carregadas é um Map em
  // memória do processo com TTL de 6h (planilha.mjs), então fica vazio depois de
  // todo restart do serviço — e planilha GERADA por gerar_documento nunca passou
  // pelo sandbox. Recarregar é barato e garante que o sub-agente edita a versão
  // canônica, não uma cópia velha que sobrou no /workspace.
  let src;
  try { src = await deps.fetchBytes(asset.s3_key); } catch (e) { src = null; }
  if (!src || !src.buffer) return { ok: false, error: 'Não consegui ler os bytes da planilha na biblioteca.' };

  let before;
  try { before = deps.inspect(src.buffer); }
  catch (e) { return { ok: false, error: `A planilha da biblioteca não abriu (${e?.message ?? e}).` }; }

  // Refaz a edição quando o resultado sai errado SEM erro técnico (recriou o
  // arquivo, salvou em outro caminho, escreveu conteúdo truncado). Devolver "olha
  // a versão anterior" seria jogar o problema no colo do usuário, que pediu uma
  // mudança e ficaria sem ela. Cada tentativa parte dos bytes ORIGINAIS: o
  // loadIntoSandbox sobrescreve o arquivo estragado da tentativa passada.
  const filename = asset.caption || 'planilha.xlsx';
  const podeConferir = typeof deps.readCells === 'function';
  let out = null, after = null, resumo = null, problema = null, tentativas = 0;
  let evid = null, clarificacao = null, semProva = true, motivoSemProva = null;
  for (let t = 1; t <= MAX_TENTATIVAS; t++) {
    tentativas = t;
    const load = await deps.loadIntoSandbox(userId, src.buffer, filename);
    if (!load?.ok) return { ok: false, error: `Não consegui carregar a planilha no ambiente: ${load?.error || 'erro'}.` };
    const path = load.path || sheetSandboxPath(filename);

    const correcao = problema
      ? `\n\nATENÇÃO — a sua tentativa anterior deu errado: ${problema.motivo}. O arquivo foi RESTAURADO pro estado original (${before.rows} linhas, ${before.sheets} aba(s)); comece de novo dele. ${problema.instrucao}`
      : '';
    try {
      resumo = await deps.runEditor({
        objetivo: objetivo + correcao, path, filename: load.filename || filename,
        sheets: before.sheets, rows: before.rows, tentativa: t,
      });
    } catch (e) {
      return { ok: false, error: `O editor falhou: ${e?.message ?? e}. Nada foi gravado; a planilha da biblioteca está intacta.` };
    }

    // Ambiguidade real: o editor devolve a PERGUNTA em vez de chutar. Não grava
    // nada e não repete a tentativa — insistir com a mesma instrução ambígua só
    // gastaria token pra chegar no mesmo lugar. O agente principal pergunta ao
    // usuário e chama a tool de novo com a instrução resolvida.
    clarificacao = pedeClarificacao(resumo);
    if (clarificacao) {
      return {
        ok: false, tentativas, clarificacao,
        error: `A instrução ficou ambígua pro editor e ele preferiu perguntar em vez de adivinhar. NÃO gravei nada — a planilha do usuário continua íntegra e com o mesmo nome. Pergunte ao usuário: ${clarificacao}`,
      };
    }

    out = await deps.readBytes(userId, path);
    if (!out?.ok || !out.buffer?.length) {
      return { ok: false, error: `Não consegui reler a planilha editada do ambiente (${out?.error || 'arquivo vazio'}). Nada foi gravado: a planilha do usuário continua íntegra e com o mesmo nome, só não recebeu a mudança.` };
    }
    try { after = deps.inspect(out.buffer); }
    catch (e) {
      return { ok: false, error: `A planilha editada saiu corrompida (${e?.message ?? e}). NÃO gravei nada: a planilha do usuário continua íntegra e com o mesmo nome, só não recebeu a mudança.` };
    }

    problema = detectarProblema({ before, after, resumo, identical: out.buffer.equals(src.buffer) });

    // Conferência de evidência: o editor declara as células que mudou e a gente
    // RELÊ exatamente essas células dos bytes salvos. É o único jeito de pegar o
    // erro que nenhuma contagem pega — a planilha ficou íntegra, do tamanho
    // certo, e o valor foi escrito no lugar errado (ou não foi escrito). A
    // comparação é deliberadamente frouxa (número por valor, texto por conteúdo,
    // fórmula por texto) porque um falso positivo aqui joga a edição boa no lixo.
    // Cada tentativa precisa de prova própria: sucesso/erro anterior não prova
    // nada sobre os bytes desta tentativa. Falta de leitura nunca vira sucesso.
    evid = null;
    semProva = true;
    motivoSemProva = 'A conferência das células não está disponível nesta execução.';
    if (!problema && podeConferir) {
      motivoSemProva = 'Não consegui reler as células declaradas para conferir a alteração.';
      const declaradas = parseEvidencia(resumo);
      if (declaradas.length) {
        let lidas = null;
        try { lidas = await deps.readCells(out.buffer, declaradas.map((e) => e.ref)); }
        catch { lidas = null; }
        if (Array.isArray(lidas)) {
          evid = conferirEvidencia(declaradas, lidas);
          semProva = evid.total === 0 || evid.conferidas !== evid.total || evid.erros.length > 0 || evid.naoVerificaveis.length > 0;
          motivoSemProva = 'Não foi possível conferir todas as células declaradas.';
          if (evid.erros.length) {
            problema = {
              motivo: `as células que você disse ter mudado não conferem no arquivo salvo: ${evid.erros.slice(0, 4).join('; ')}`,
              instrucao: 'Ou você escreveu no lugar errado, ou salvou num caminho diferente do que recebeu, ou declarou uma evidência que não conferiu. Reabra o arquivo ORIGINAL, localize a célula por código (procurando o valor, não contando linhas), escreva, salve no MESMO caminho, REABRA e leia de volta as células antes de declarar EVIDENCIA.',
            };
          }
        }
      } else {
        // Sem evidência não dá pra conferir nada. Vale uma segunda passada
        // pedindo, mas não vale recusar a edição no fim: entregar com ressalva é
        // melhor que gastar o token do usuário e não entregar nada. Por isso o
        // semEvidencia só vira `problema` (= refaz) enquanto sobra tentativa; na
        // última ele fica só como flag e a edição é gravada com aviso.
        semProva = true;
        motivoSemProva = 'O editor não declarou as células que mudou.';
        if (t < MAX_TENTATIVAS) {
          problema = {
            motivo: 'você não declarou nenhuma célula no formato EVIDENCIA: Aba!C8=valor, então não tive como conferir se a mudança foi pro lugar certo',
            instrucao: 'Refaça a partir do original e, no resumo, inclua uma linha "EVIDENCIA: Aba!Celula=valor" por célula que você mudou (até 20), com o valor lido DEPOIS de reabrir o arquivo salvo.',
          };
        }
      }
    }
    if (!problema) break;
  }
  // Esgotou as tentativas: não grava nada. A planilha do usuário fica exatamente
  // como estava, com o mesmo nome — não existe "versão anterior" pra ele caçar,
  // e o modelo tem o motivo concreto pra explicar o que não deu.
  // Exceção: falta de evidência não é defeito na planilha, é falta de prova. O
  // arquivo passou em todas as checagens objetivas (não foi recriado, não
  // encolheu, não perdeu peça, não tem marcador de corte). Nesse caso grava e
  // avisa que a mudança não foi conferida célula a célula.
  if (problema) {
    return {
      ok: false, tentativas,
      error: `Tentei ${tentativas}x e não consegui aplicar a mudança: ${problema.motivo}. NÃO gravei nada — a planilha do usuário continua íntegra e com o mesmo nome. Explique pro usuário que a mudança não foi aplicada (não ofereça "versão anterior": a atual já é a boa) e, se der, peça a mudança em partes menores ou mais específica. Último relato do editor: ${resumo}`,
    };
  }

  // Grava a versão NOVA primeiro (com o nome canônico) e só depois arquiva a
  // anterior. Nessa ordem, uma falha na renomeação deixa duas linhas com o mesmo
  // nome — recuperável, e a mais nova continua ganhando por created_at DESC.
  // Na ordem inversa, uma falha na gravação perderia o nome canônico.
  const caption = filename;
  const ext = (String(caption).match(SHEET_EXT_RE)?.[0] || '.xlsx').slice(1).toLowerCase();
  let saved;
  try {
    saved = await deps.saveAsset({
      buffer: out.buffer, ext,
      mime: asset.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      caption,
    });
  } catch (e) {
    return { ok: false, error: `Não consegui salvar a planilha editada na biblioteca (${e?.message ?? e}). A planilha do usuário continua íntegra e com o mesmo nome, só não recebeu a mudança.` };
  }
  let arquivada = null;
  try {
    arquivada = versionedCaption(caption, asset.created_at, { id: asset.id });
    await deps.renameAsset(userId, asset.id, arquivada);
  } catch (e) { arquivada = null; }

  const avisos = [];
  if (declarouRemocao(resumo) && (Number(after.rows) || 0) < (Number(before.rows) || 0)) {
    avisos.push(`O editor removeu linhas de propósito (${before.rows} → ${after.rows}), por entender que a instrução pedia isso. Confirme com o usuário se era essa a intenção.`);
  }
  if (tentativas > 1) {
    avisos.push(`Precisei de ${tentativas} tentativas: a primeira saiu errada e foi refeita a partir do arquivo original.`);
  }
  const acessorias = pecasPerdidas(before, after).acessorias;
  if (acessorias.length) {
    avisos.push(`A regravação descartou metadado interno do Excel (${acessorias.slice(0, 4).join(', ')}). Não afeta dados, fórmulas nem formatação — o Excel recria na próxima vez que salvar.`);
  }
  if (semProva) {
    avisos.push(`${motivoSemProva} NÃO consegui conferir célula a célula toda a alteração. O arquivo passou nas verificações estruturais disponíveis, mas isso não comprova a correção de todo o conteúdo. Informe essa limitação ao usuário; não apresente o resultado como integralmente conferido.`);
  }
  if (evid && evid.erros.length === 0 && evid.conferidas > 0) {
    avisos.push(`Conferido por código: reli ${evid.conferidas} de ${evid.total} célula(s) declarada(s) direto do arquivo salvo e os valores batem segundo os critérios do verificador. Isso não valida células não declaradas nem a autenticidade das fontes.`);
  }
  if (evid && evid.naoVerificaveis.length) {
    avisos.push(`Não deu pra conferir por código: ${evid.naoVerificaveis.slice(0, 3).join('; ')}.`);
  }
  return {
    ok: true, tentativas,
    asset: { id: saved.assetId ?? null, key: saved.key, url: saved.url, caption, mime: asset.mime, ext },
    before, after,
    delta: describeDelta(before, after),
    evidencia: evid,
    avisos,
    arquivada,
    resumo,
  };
}

export default {
  editSpreadsheet, pickSheetAsset, versionedCaption, hasCutMarker, describeDelta,
  detectarProblema, declarouRemocao, withKeyLock, isSheetAsset,
  pecasPerdidas, pedeClarificacao, parseEvidencia, conferirEvidencia, SENTINELA_CLARIFICACAO,
};
