// Visão do dono do atendimento ao público (publico.mjs): configurar o modo
// público de um assistente, ver os contatos e as conversas (só leitura), bloquear,
// exportar e apagar um contato. A tela é web/public/atendimento.html (/atendimento).
//
// Toda rota exige sessão. O dono é conferido no SQL do store (agents.user_id), e
// contato ou assistente de outra conta responde 404, igual a um id que não existe.
// As que mudam estado são POST e passam pelo CSRF global do servidor.
import { readBody } from './http-body.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (UUID.test(String(v || '')) ? String(v) : null);
const inteiro = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const TETO_MAX_USD = 100000;

// O que vem do formulário vira campos do store.configurar; campo ausente fica
// como está. Devolve {erro} se algum valor não vale.
export function camposDaConfig(b = {}) {
  const c = {};
  if (b.ativo !== undefined) { if (typeof b.ativo !== 'boolean') return { erro: 'ativo precisa ser verdadeiro ou falso.' }; c.ativo = b.ativo; }
  if (b.instrucoes !== undefined) { if (typeof b.instrucoes !== 'string') return { erro: 'Instruções inválidas.' }; c.instrucoes = b.instrucoes; }
  if (b.retencaoDias !== undefined) {
    c.retencaoDias = inteiro(b.retencaoDias, 1, 3650);
    if (c.retencaoDias === undefined) return { erro: 'A retenção vai de 1 a 3650 dias.' };
  }
  if (b.limitePorHora !== undefined) {
    c.limitePorHora = inteiro(b.limitePorHora, 1, 600);
    if (c.limitePorHora === undefined) return { erro: 'O limite por hora vai de 1 a 600 mensagens.' };
  }
  if (b.tetoDiarioUsd !== undefined) {
    const t = b.tetoDiarioUsd;
    if (t !== null && !(typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= TETO_MAX_USD)) return { erro: 'O teto diário precisa ser um valor em US$ maior que zero, ou vazio pra não ter teto.' };
    c.tetoDiarioUsd = t;
  }
  return { campos: c };
}

// deps: rotas (rotas.mjs), store (createPublicoStore), send/fail/tooManyRequests
// do servidor, agenteDoNumero() = id do assistente que atende o número da instalação.
export function registrarRotasDoDono({ rotas, store, send, fail, tooManyRequests, agenteDoNumero }) {
  // Envolve cada rota: sessão, sem cache, limite de pedidos e erro sem detalhe.
  const rota = (metodo, caminho, tratar) => rotas.registrar(metodo, caminho, async (req, res, url, ctx) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = await ctx.currentUser?.();
    if (!user) return send(res, 401, { error: 'Faça login pra ver o atendimento ao público.' });
    if (tooManyRequests(req, res, 'publico-dono', 120, 60_000)) return;
    try { return await tratar({ req, res, url, user }); }
    catch (e) { return fail(res, 500, 'Falha no atendimento ao público.', e); }
  });
  const naoAchei = (res) => send(res, 404, { error: 'Não encontrado.' });
  // Contato do pedido, só se for do dono.
  const contatoDoPedido = async (user, id) => { const c = uuid(id); return c && (await store.contatoDoDono(user.id, c)) ? c : null; };

  rota('GET', '/api/publico/agentes', async ({ res, user }) => {
    const doNumero = agenteDoNumero();
    const agentes = (await store.agentesDoDono(user.id)).map((a) => ({
      agentId: a.agent_id, nome: a.nome, configurado: a.configurado, ativo: a.ativo, instrucoes: a.instrucoes,
      retencaoDias: a.retencao_dias, limitePorHora: a.limite_por_hora, tetoDiarioUsd: a.teto_diario_usd,
      contatos: a.contatos, doNumero: a.agent_id === doNumero,
    }));
    return send(res, 200, { agentes });
  });

  rota('POST', '/api/publico/configurar', async ({ req, res, user }) => {
    const b = await readBody(req);
    const agentId = uuid(b.agentId);
    if (!agentId) return naoAchei(res);
    const { campos, erro } = camposDaConfig(b);
    if (erro) return send(res, 400, { error: erro });
    const r = await store.configurar(agentId, user.id, campos);
    if (!r) return naoAchei(res);
    return send(res, 200, { ok: true, agentId: r.agent_id, ativo: r.ativo, instrucoes: r.instrucoes, retencaoDias: r.retencao_dias,
      limitePorHora: r.limite_por_hora, tetoDiarioUsd: r.teto_diario_usd });
  });

  rota('GET', '/api/publico/contatos', async ({ res, url, user }) => {
    const agentId = uuid(url.searchParams.get('agente'));
    if (!agentId) return naoAchei(res);
    const antes = url.searchParams.get('antes');
    const quando = antes && !Number.isNaN(Date.parse(antes)) ? new Date(antes).toISOString() : null;
    return send(res, 200, { contatos: await store.contatosDoDono(user.id, agentId, { antes: quando }) });
  });

  rota('GET', '/api/publico/conversa', async ({ res, url, user }) => {
    const contatoId = await contatoDoPedido(user, url.searchParams.get('contato'));
    if (!contatoId) return naoAchei(res);
    const antes = Number(url.searchParams.get('antes'));
    return send(res, 200, { mensagens: await store.conversaDoDono(user.id, contatoId, { antes: Number.isSafeInteger(antes) && antes > 0 ? antes : null }) });
  });

  rota('POST', '/api/publico/bloquear', async ({ req, res, user }) => {
    const b = await readBody(req);
    const contatoId = await contatoDoPedido(user, b.contatoId);
    if (!contatoId) return naoAchei(res);
    if (typeof b.bloqueado !== 'boolean') return send(res, 400, { error: 'bloqueado precisa ser verdadeiro ou falso.' });
    await store.bloquear(contatoId, b.bloqueado);
    return send(res, 200, { ok: true, bloqueado: b.bloqueado });
  });

  rota('POST', '/api/publico/apagar', async ({ req, res, user }) => {
    const contatoId = await contatoDoPedido(user, (await readBody(req)).contatoId);
    if (!contatoId) return naoAchei(res);
    await store.apagarContato(contatoId);
    return send(res, 200, { ok: true });
  });

  // Pedido de acesso do titular (LGPD): o dono baixa tudo o que existe do contato.
  rota('GET', '/api/publico/exportar', async ({ res, url, user }) => {
    const contatoId = await contatoDoPedido(user, url.searchParams.get('contato'));
    if (!contatoId) return naoAchei(res);
    const dados = await store.exportar(contatoId);
    if (!dados) return naoAchei(res);
    return send(res, 200, dados, { 'content-disposition': `attachment; filename="contato-${contatoId}.json"` });
  });
}
