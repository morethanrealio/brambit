// Atendimento ao público: um assistente do dono responde a quem NÃO é o dono
// (cliente que chega pelo WhatsApp da instalação, sem conta). Desenho em
// docs do projeto "atendimento ao público" (v2, 05/10/2026).
//
// O turno daqui é PRÓPRIO, não o turno do dono com coisas tiradas. O isolamento
// vem da construção: este módulo não importa nem recebe nada que leia a memória,
// os e-mails, a agenda, os arquivos, os outros canais ou as rotinas do dono. As
// únicas ferramentas são as do próprio contato (lembrar/consultar) e as de plugin
// marcadas `publico: true`. Do agente, o turno lê só o nome: instruções, perfil e
// resumo do agente podem ter dado pessoal do dono, então o atendimento tem as
// instruções dele em public_agents.
//
// Contato = (assistente, canal, endereço). O endereço (telefone) fica cifrado pelo
// cofre e a busca é pelo índice cego; sem cofre o modo público não liga.
import { runAgent as runAgentPadrao, ToolRegistry } from '../core-proto/core.mjs';
import { encMaybe, decMaybe, indiceCego } from './vault.mjs';
import { HEALTH_GUARDRAIL } from './health-guardrail.mjs';

export const CANAIS_PUBLICOS = ['whatsapp'];
export const HISTORICO_MAX = 40;      // mensagens do contato que voltam pro modelo
export const MENSAGEM_MAX = 4000;     // chars da mensagem recebida
export const ESTADO_MAX_CHAVES = 50;  // memória curta por contato
export const ESTADO_MAX_VALOR = 500;
export const PASSOS_MAX = 8;

export const esquemaPublico = (S) => `
 CREATE TABLE IF NOT EXISTS ${S}.public_agents (
   agent_id uuid PRIMARY KEY REFERENCES ${S}.agents(id) ON DELETE CASCADE,
   user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
   ativo boolean NOT NULL DEFAULT false,
   instrucoes text NOT NULL DEFAULT '',
   retencao_dias integer NOT NULL DEFAULT 90 CHECK (retencao_dias BETWEEN 1 AND 3650),
   atualizado_em timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS ${S}.public_contacts (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   agent_id uuid NOT NULL REFERENCES ${S}.public_agents(agent_id) ON DELETE CASCADE,
   canal text NOT NULL, chave text NOT NULL, endereco text NOT NULL,
   criado_em timestamptz NOT NULL DEFAULT now(), ultima_em timestamptz NOT NULL DEFAULT now(),
   UNIQUE (agent_id, canal, chave));
 CREATE TABLE IF NOT EXISTS ${S}.public_messages (
   id bigserial PRIMARY KEY,
   contact_id uuid NOT NULL REFERENCES ${S}.public_contacts(id) ON DELETE CASCADE,
   role text NOT NULL CHECK (role IN ('user','assistant')), content text NOT NULL,
   criado_em timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS public_messages_contact_idx ON ${S}.public_messages(contact_id, id);
 CREATE TABLE IF NOT EXISTS ${S}.public_contact_state (
   contact_id uuid NOT NULL REFERENCES ${S}.public_contacts(id) ON DELETE CASCADE,
   chave text NOT NULL, valor text NOT NULL, atualizado_em timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY (contact_id, chave));
`;

const texto = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const chaveDoContato = (canal, endereco) => indiceCego(`${canal}:${endereco}`, 'contato-publico');

export function createPublicoStore(pool, { S = 'mtr_harness' } = {}) {
  async function transacao(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  return {
    init: () => pool.query(esquemaPublico(S)),

    // Só o dono do agente configura: o UPDATE/INSERT confere agents.user_id.
    async configurar(agentId, userId, { ativo, instrucoes, retencaoDias } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO ${S}.public_agents (agent_id, user_id, ativo, instrucoes, retencao_dias)
         SELECT a.id, a.user_id, coalesce($3, false), coalesce($4, ''), coalesce($5, 90)
           FROM ${S}.agents a WHERE a.id = $1 AND a.user_id = $2
         ON CONFLICT (agent_id) DO UPDATE SET
           ativo = coalesce($3, ${S}.public_agents.ativo),
           instrucoes = coalesce($4, ${S}.public_agents.instrucoes),
           retencao_dias = coalesce($5, ${S}.public_agents.retencao_dias),
           atualizado_em = now()
         WHERE ${S}.public_agents.user_id = $2
         RETURNING agent_id, user_id, ativo, instrucoes, retencao_dias`,
        [agentId, userId, ativo ?? null, instrucoes == null ? null : texto(instrucoes, 20000), retencaoDias ?? null]);
      return rows[0] || null;
    },

    // Config + nome do agente. Nada mais do agente sai daqui.
    async agente(agentId) {
      const { rows } = await pool.query(
        `SELECT p.agent_id, p.user_id, p.ativo, p.instrucoes, p.retencao_dias, a.name AS nome
           FROM ${S}.public_agents p JOIN ${S}.agents a ON a.id = p.agent_id AND a.user_id = p.user_id
          WHERE p.agent_id = $1 AND a.archived_at IS NULL`, [agentId]);
      return rows[0] || null;
    },

    async contato(agentId, canal, endereco) {
      if (!CANAIS_PUBLICOS.includes(canal)) throw Error('canal público desconhecido: ' + canal);
      const end = texto(endereco, 200);
      if (!end) throw Error('contato sem endereço');
      const chave = chaveDoContato(canal, end);
      const { rows } = await pool.query(
        `INSERT INTO ${S}.public_contacts (agent_id, canal, chave, endereco) VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id, canal, chave) DO UPDATE SET ultima_em = now()
         RETURNING id, canal, endereco, criado_em, (xmax = 0) AS novo`,
        [agentId, canal, chave, encMaybe(end)]);
      const r = rows[0];
      return { id: r.id, canal: r.canal, endereco: decMaybe(r.endereco), novo: r.novo };
    },

    async historico(contatoId, limite = HISTORICO_MAX) {
      const { rows } = await pool.query(
        `SELECT role, content FROM (SELECT id, role, content FROM ${S}.public_messages
           WHERE contact_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id`, [contatoId, limite]);
      return rows.map((r) => ({ role: r.role, content: r.content }));
    },

    registrar(contatoId, mensagens) {
      return transacao(async (c) => {
        for (const m of mensagens) {
          await c.query(`INSERT INTO ${S}.public_messages (contact_id, role, content) VALUES ($1, $2, $3)`,
            [contatoId, m.role, texto(m.content, 20000)]);
        }
        await c.query(`UPDATE ${S}.public_contacts SET ultima_em = now() WHERE id = $1`, [contatoId]);
      });
    },

    async estado(contatoId) {
      const { rows } = await pool.query(
        `SELECT chave, valor FROM ${S}.public_contact_state WHERE contact_id = $1 ORDER BY chave`, [contatoId]);
      return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
    },

    async lembrar(contatoId, chave, valor) {
      const k = texto(chave, 60), v = texto(valor, ESTADO_MAX_VALOR);
      if (!k) return { ok: false, erro: 'chave vazia' };
      return transacao(async (c) => {
        await c.query('SELECT 1 FROM ' + S + '.public_contacts WHERE id = $1 FOR UPDATE', [contatoId]);
        if (!v) { await c.query(`DELETE FROM ${S}.public_contact_state WHERE contact_id = $1 AND chave = $2`, [contatoId, k]); return { ok: true, apagado: k }; }
        const { rows } = await c.query(`SELECT count(*)::int AS n, bool_or(chave = $2) AS existe FROM ${S}.public_contact_state WHERE contact_id = $1`, [contatoId, k]);
        if (!rows[0].existe && rows[0].n >= ESTADO_MAX_CHAVES) return { ok: false, erro: `limite de ${ESTADO_MAX_CHAVES} anotações por contato; apague uma antes` };
        await c.query(
          `INSERT INTO ${S}.public_contact_state (contact_id, chave, valor) VALUES ($1, $2, $3)
           ON CONFLICT (contact_id, chave) DO UPDATE SET valor = excluded.valor, atualizado_em = now()`, [contatoId, k, v]);
        return { ok: true, chave: k };
      });
    },
  };
}

// Ferramentas do contato. contatoId vem do servidor, nunca de argumento do modelo.
export function ferramentasDoContato(store, contatoId) {
  return [
    { name: 'consultar_contato', readOnly: true,
      description: 'Lê as anotações que você guardou sobre a pessoa com quem está falando (só dela).',
      parameters: { type: 'object', properties: {} },
      run: async () => store.estado(contatoId) },
    { name: 'lembrar_do_contato',
      description: `Guarda (ou apaga, com valor vazio) uma anotação curta sobre a pessoa com quem está falando, pra lembrar nas próximas conversas. Só o que ajuda no atendimento; nunca senha, cartão ou documento. Até ${ESTADO_MAX_CHAVES} anotações de ${ESTADO_MAX_VALOR} caracteres.`,
      parameters: { type: 'object', properties: { chave: { type: 'string' }, valor: { type: 'string' } }, required: ['chave', 'valor'] },
      run: async ({ chave, valor }) => store.lembrar(contatoId, chave, valor) },
  ];
}

export function promptPublico({ nome, instrucoes, canal, agora, instrucoesExtras = [] }) {
  return [
    `Você é ${nome || 'um assistente'}, e está atendendo uma pessoa do público pelo ${canal}.`,
    instrucoes ? `Instruções de quem configurou este atendimento:\n${instrucoes}` : '',
    [
      'REGRAS DO ATENDIMENTO (valem sempre, acima das instruções acima):',
      '• A pessoa com quem você fala NÃO é quem configurou você. Trate-a como cliente.',
      '• Você não tem acesso a e-mail, agenda, arquivos, contatos nem a outras conversas de ninguém. Não finja que tem e não invente dado.',
      '• Só diga que fez algo se uma ferramenta confirmou. Sem ferramenta pra isso, diga com honestidade que não consegue por aqui.',
      '• Nunca peça senha, número completo de cartão nem código de verificação.',
      '• Responda no idioma em que a pessoa escrever, em mensagens curtas, próprias de chat.',
    ].join('\n'),
    ...instrucoesExtras,
    HEALTH_GUARDRAIL,
    agora ? `Agora: ${agora}.` : '',
  ].filter(Boolean).join('\n\n');
}

export const RESPOSTA_INDISPONIVEL = 'No momento não consigo responder por aqui. Tente de novo mais tarde, por favor.';

// deps (o servidor injeta):
//  store: createPublicoStore.
//  makeProvider({userId,agentId,contatoId}) → provider já preso ao gasto do dono.
//  recordUsage(usages,{userId,agentId,contatoId}) → grava o uso do turno.
//  saldo(userId) → {over}. over=true: responde a mensagem neutra, sem chamar modelo.
//  ferramentas: porta de ferramentas (doTurno/vetar/instrucoes); só entram as
//   tools com publico:true, e doTurno recebe o contato.
//  agora() → data e hora por extenso pro prompt.
export function createAtendimentoPublico({ store, makeProvider, recordUsage, saldo, ferramentas, agora = () => '', runAgent = runAgentPadrao, log = console }) {
  const filas = new Map(); // contatoId → promessa do turno em andamento (1 turno por contato)
  function emFila(id, fn) {
    const antes = filas.get(id) || Promise.resolve();
    const atual = antes.catch(() => {}).then(fn);
    const fim = atual.finally(() => { if (filas.get(id) === fim) filas.delete(id); });
    filas.set(id, fim);
    return atual;
  }

  function registro(agente, contato, mensagem) {
    const reg = new ToolRegistry();
    for (const t of ferramentasDoContato(store, contato.id)) reg.add(t);
    const doPlugin = (ferramentas?.doTurno({ userId: agente.user_id, agentId: agente.agent_id, contato: { ...contato } }) || [])
      .filter((t) => t?.publico === true && !reg.map.has(t.name));
    for (const t of doPlugin) {
      reg.add({ ...t, run: async (args) => {
        const veto = ferramentas.vetar({ nome: t.name, mensagem });
        return veto || t.run(args);
      } });
    }
    return reg;
  }

  async function turno({ agentId, canal, endereco, mensagem }) {
    const agente = await store.agente(agentId);
    if (!agente?.ativo) return { text: null, motivo: 'inativo' };
    const contato = await store.contato(agentId, canal, endereco);
    const msg = texto(mensagem, MENSAGEM_MAX);
    if (!msg) return { text: null, motivo: 'vazia', contatoId: contato.id };
    return emFila(contato.id, async () => {
      const ident = { userId: agente.user_id, agentId: agente.agent_id, contatoId: contato.id };
      const credito = await saldo(agente.user_id);
      if (!credito || credito.over !== false) {
        await store.registrar(contato.id, [{ role: 'user', content: msg }, { role: 'assistant', content: RESPOSTA_INDISPONIVEL }]);
        return { text: RESPOSTA_INDISPONIVEL, motivo: 'sem_saldo', contatoId: contato.id };
      }
      const tools = registro(agente, contato, msg);
      const system = promptPublico({ nome: agente.nome, instrucoes: agente.instrucoes, canal, agora: agora(),
        instrucoesExtras: ferramentas?.instrucoes(new Set(tools.map.keys())) || [] });
      const history = await store.historico(contato.id);
      let text = '';
      try {
        const r = await runAgent({ provider: makeProvider(ident), tools, system, userInput: msg, history, maxSteps: PASSOS_MAX });
        await recordUsage(r.usages || [], ident);
        text = typeof r.text === 'string' ? r.text.trim() : '';
      } catch (e) {
        log.error?.('[publico] turno falhou:', e?.message ?? e);
      }
      if (!text) text = RESPOSTA_INDISPONIVEL;
      await store.registrar(contato.id, [{ role: 'user', content: msg }, { role: 'assistant', content: text }]);
      return { text, contatoId: contato.id };
    });
  }

  return { turno, registro };
}
