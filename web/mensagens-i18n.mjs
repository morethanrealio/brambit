// Tradução das MENSAGENS DO SERVIDOR (o campo `error`/`message` das respostas
// JSON), irmã de site-i18n.mjs, que cuida do HTML.
//
// Por que um módulo separado do site: a origem é outra. O HTML é dado, e o
// walker sabe o que é texto porque conhece a gramática de tag. Aqui a origem é
// CÓDIGO, e o que decide se um literal vai pra tela do usuário não é o conteúdo
// dele, é o ponto de emissão. `'locked'`, `'bad_request'` e "Faça login." estão
// no mesmo arquivo, saem pela mesma função e só um dos três é frase.
//
// A garantia é a mesma do site e pelo mesmo motivo: em pt-BR nada é percorrido e
// a resposta sai byte a byte igual à de hoje. Chave sem tradução continua em
// português, de propósito: mensagem faltando é uma frase fora de idioma, e
// mensagem inventada é uma frase errada.
import { IDIOMAS_OK, IDIOMA_PADRAO, tagIdioma } from './locale.mjs';
import { fatiaJs } from './site-i18n.mjs';
import { hostDaMarca, marca } from './marca.mjs';

// Os pontos de emissão que chegam ao CLIENTE. `fail()` e `send()` são as duas
// portas de saída JSON do servidor; o que passa por elas a pessoa lê.
//
// `return { error: ... }` fica de FORA de propósito, e essa é a distinção que
// importa neste arquivo: aquilo é retorno de tool, vai pro modelo, não pra tela.
// O modelo já responde no idioma de quem perguntou, então traduzir ali não
// ajudaria ninguém e mexeria no texto que guia a decisão dele.
const EMISSORES = [
  /\bfail\s*\(\s*res\s*,\s*\d+\s*,\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{\s*error\s*:\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{[^{}]*\bmessage\s*:\s*$/,
  // O literal de reserva depois de `||` (`e?.message || 'URL inválida.'`) também
  // chega à tela quando a expressão da esquerda vem vazia.
  /\bfail\s*\(\s*res\s*,\s*\d+\s*,[^,{}()'"`]*\|\|\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{\s*error\s*:[^,{}()'"`]*\|\|\s*$/,
  // Texto que uma porta devolve pro servidor responder (`{ mensagem: '...' }`,
  // ex.: entrarNaFila da porta de permissões) vira `message` na resposta.
  /\{\s*mensagem\s*:\s*$/,
];

// Código de máquina, não frase: minúsculas, dígitos, `_` e `-`, sem espaço nem
// acento nem pontuação (`locked`, `no_agent`, `bad_request`, `apple-em-uso`).
// A exclusão é por FORMA, não por lista: lista nova esquece o próximo código.
// Traduzir um desses não deixaria a tela feia, deixaria o cliente comparando
// contra um valor que mudou de idioma.
const CODIGO_DE_MAQUINA = /^[a-z][a-z0-9_-]*$/;

// Arquivos do núcleo (dentro de web/) cujas respostas passam pelo send/fail do
// servidor e, portanto, pelo catálogo web/textos-servidor. Módulo novo do núcleo
// que responde por esse send entra aqui; o de plugin vai no fontesMensagens dele,
// com o catálogo no textosServidor (plugins.mjs).
export const FONTES_MENSAGENS = ['server.mjs'];

// Mensagens de usuário emitidas como literal no código. Devolve as strings
// únicas, na ordem em que aparecem.
//
// Fora ficam os templates (crase com `${}`): o texto deles só existe montado, em
// tempo de execução, então não há chave estável pra guardar num catálogo. São
// poucos e continuam em português; `mensagens-i18n-pendentes.mjs` os lista.
export function extraiMensagens(js) {
  const fora = [];
  const vistos = new Set();
  for (const p of fatiaJs(js)) {
    if (p.tipo !== 'string') continue;
    const antes = js.slice(Math.max(0, p.ini - 90), p.ini);
    if (!EMISSORES.some((re) => re.test(antes))) continue;
    const texto = js.slice(p.ini + 1, p.fim - 1);
    // Literal com escape (`\'`, `\n`) não vira chave: a chave teria que ser o
    // valor JÁ desescapado pra bater em tempo de execução, e a substituição
    // teria que reescapar. Nenhum dos dois lados vale o risco por um punhado de
    // frases; ficam em português e o pendentes as mostra.
    if (texto.includes('\\')) continue;
    if (!texto.trim() || CODIGO_DE_MAQUINA.test(texto)) continue;
    if (vistos.has(texto)) continue;
    vistos.add(texto);
    fora.push(texto);
  }
  return fora;
}

// Ponto único chamado pelo servidor, um texto por vez. Em pt-BR devolve a MESMA
// string sem consultar nada, que é o que garante que a resposta de hoje não muda
// um byte. Fora do catálogo, também devolve a mesma string.
export function traduzMensagem(texto, language, catalogos) {
  if (typeof texto !== 'string' || !texto) return texto;
  const tag = tagIdioma(language);
  if (tag === IDIOMA_PADRAO) return texto;
  const t = catalogos?.[tag]?.[texto];
  return typeof t === 'string' && t ? t : texto;
}

// O nome do produto entra na mensagem como __MARCA__ e o e-mail de suporte como
// __SUPORTE__ (no código e nas duas pontas do catálogo), pra a chave continuar
// sendo um literal fixo, e viram os da marca só aqui, depois da tradução e em
// qualquer idioma. Instalação sem e-mail de suporte na marca responde com o
// ADMIN_EMAIL e, sem ele, com o endereço do site.
const MARCA = /__MARCA__|__SUPORTE__/g;
const daMarca = (k) => (k === '__MARCA__' ? marca().nome : marca().suporte || process.env.ADMIN_EMAIL || hostDaMarca());
const comMarca = (t) => (t.includes('__') ? t.replace(MARCA, daMarca) : t);

// Traduz só os dois campos que a pessoa lê na tela, `error` e `message`, e não
// encosta no resto do objeto: `ok`, `queued`, id, saldo e qualquer dado seguem
// como estão.
//
// Em pt-BR e em qualquer texto fora do catálogo (e sem __MARCA__ nem __SUPORTE__)
// devolve o MESMO objeto, pela mesma referência, então a resposta continua byte a
// byte a de hoje.
// A cópia só nasce quando algum campo de fato mudou.
export function traduzResposta(obj, language, catalogos) {
  if (!obj || typeof obj !== 'object') return obj;
  const pt = tagIdioma(language) === IDIOMA_PADRAO;
  let saida = obj;
  for (const campo of ['error', 'message']) {
    const v = obj[campo];
    if (typeof v !== 'string') continue;
    const t = comMarca(pt ? v : traduzMensagem(v, language, catalogos));
    if (t === v) continue;
    if (saida === obj) saida = { ...obj };
    saida[campo] = t;
  }
  return saida;
}

// Idioma de uma requisição, resolvido SEM ir ao banco.
//
// A ordem existe por um motivo: a SPA manda `X-Idioma` com o idioma em que ela
// própria foi servida, e aquela página já saiu na preferência SALVA da pessoa
// (o servidor resolveu isso no `idiomaDaPagina`). Então o header do cliente não
// é palpite, é o eco da preferência, e ainda garante o que o usuário espera:
// a mensagem de erro chega no mesmo idioma da tela que a provocou.
//
// Cliente que não manda o header (extensão, app, curl) cai no Accept-Language do
// próprio agente, e quem não manda nem isso cai em português.
export function idiomaDaRequisicao(req, doHeader) {
  const pedido = String(req.headers?.['x-idioma'] || '').trim();
  if (IDIOMAS_OK.includes(pedido)) return pedido;
  try { return doHeader(req).language || IDIOMA_PADRAO; } catch { return IDIOMA_PADRAO; }
}
