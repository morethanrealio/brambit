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
import { normalizarSaidas, textoDasSaidas } from './publico-saidas.mjs';

export const CANAIS_PUBLICOS = ['whatsapp'];
export const HISTORICO_MAX = 40;      // mensagens do contato que voltam pro modelo
export const MENSAGEM_MAX = 4000;     // chars da mensagem recebida
export const ESTADO_MAX_CHAVES = 50;  // memória curta por contato
export const ESTADO_MAX_VALOR = 500;
export const PASSOS_MAX = 8;
export const LIMITE_POR_HORA = 30;    // mensagens de um contato por hora que chegam ao modelo
export const LIMPEZA_LOTE = 5000;
export const CONTATOS_POR_PAGINA = 100;
export const CONVERSA_POR_PAGINA = 100;

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
 ALTER TABLE ${S}.public_agents ADD COLUMN IF NOT EXISTS limite_por_hora integer NOT NULL DEFAULT ${LIMITE_POR_HORA} CHECK (limite_por_hora BETWEEN 1 AND 600);
 ALTER TABLE ${S}.public_agents ADD COLUMN IF NOT EXISTS teto_diario_usd numeric(12,4) CHECK (teto_diario_usd > 0);
 ALTER TABLE ${S}.public_contacts ADD COLUMN IF NOT EXISTS parado_em timestamptz;
 ALTER TABLE ${S}.public_contacts ADD COLUMN IF NOT EXISTS limite_avisado_em timestamptz;
 ALTER TABLE ${S}.public_contacts ADD COLUMN IF NOT EXISTS bloqueado_em timestamptz;
 CREATE INDEX IF NOT EXISTS public_contacts_agente_idx ON ${S}.public_contacts(agent_id, ultima_em DESC);
 CREATE INDEX IF NOT EXISTS public_messages_criado_idx ON ${S}.public_messages(criado_em);
`;

const texto = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const chaveDoContato = (canal, endereco) => indiceCego(`${canal}:${endereco}`, 'contato-publico');
const COLUNAS_AGENTE = 'agent_id, user_id, ativo, instrucoes, retencao_dias, limite_por_hora, teto_diario_usd::float AS teto_diario_usd';

// fuso: o "dia" do teto de gasto começa à meia-noite deste fuso.
export function createPublicoStore(pool, { S = 'mtr_harness', fuso = 'America/Sao_Paulo' } = {}) {
  async function transacao(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  return {
    init: () => pool.query(esquemaPublico(S)),

    // Só o dono do agente configura: o UPDATE/INSERT confere agents.user_id.
    // Campo ausente fica como está; tetoDiarioUsd: null tira o teto.
    async configurar(agentId, userId, { ativo, instrucoes, retencaoDias, limitePorHora, tetoDiarioUsd } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO ${S}.public_agents (agent_id, user_id, ativo, instrucoes, retencao_dias, limite_por_hora, teto_diario_usd)
         SELECT a.id, a.user_id, coalesce($3, false), coalesce($4, ''), coalesce($5, 90), coalesce($6, ${LIMITE_POR_HORA}), $7::numeric
           FROM ${S}.agents a WHERE a.id = $1 AND a.user_id = $2
         ON CONFLICT (agent_id) DO UPDATE SET
           ativo = coalesce($3, ${S}.public_agents.ativo),
           instrucoes = coalesce($4, ${S}.public_agents.instrucoes),
           retencao_dias = coalesce($5, ${S}.public_agents.retencao_dias),
           limite_por_hora = coalesce($6, ${S}.public_agents.limite_por_hora),
           teto_diario_usd = CASE WHEN $8 THEN $7::numeric ELSE ${S}.public_agents.teto_diario_usd END,
           atualizado_em = now()
         WHERE ${S}.public_agents.user_id = $2
         RETURNING ${COLUNAS_AGENTE}`,
        [agentId, userId, ativo ?? null, instrucoes == null ? null : texto(instrucoes, 20000), retencaoDias ?? null,
          limitePorHora ?? null, tetoDiarioUsd ?? null, tetoDiarioUsd !== undefined]);
      return rows[0] || null;
    },

    // Config + nome do agente. Nada mais do agente sai daqui.
    async agente(agentId) {
      const { rows } = await pool.query(
        `SELECT p.agent_id, p.user_id, p.ativo, p.instrucoes, p.retencao_dias, p.limite_por_hora,
                p.teto_diario_usd::float AS teto_diario_usd, a.name AS nome
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
         RETURNING id, canal, endereco, criado_em, parado_em, limite_avisado_em, bloqueado_em, (xmax = 0) AS novo`,
        [agentId, canal, chave, encMaybe(end)]);
      const r = rows[0];
      return { id: r.id, canal: r.canal, endereco: decMaybe(r.endereco), novo: r.novo, paradoEm: r.parado_em, limiteAvisadoEm: r.limite_avisado_em, bloqueadoEm: r.bloqueado_em };
    },

    // "parar": o assistente para de responder esse contato até ele mandar "voltar".
    async parar(contatoId, parado) {
      await pool.query(`UPDATE ${S}.public_contacts SET parado_em = ${parado ? 'now()' : 'NULL'} WHERE id = $1`, [contatoId]);
    },

    // Bloqueio é do dono (só ele desfaz); "parar" é do contato.
    async bloquear(contatoId, bloqueado) {
      await pool.query(`UPDATE ${S}.public_contacts SET bloqueado_em = ${bloqueado ? 'now()' : 'NULL'} WHERE id = $1`, [contatoId]);
    },

    // Mensagens do contato na última hora (as que foram ao modelo ficam gravadas).
    async mensagensNaUltimaHora(contatoId) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${S}.public_messages
          WHERE contact_id = $1 AND role = 'user' AND criado_em > now() - interval '1 hour'`, [contatoId]);
      return rows[0].n;
    },

    // Marca o aviso de limite; devolve true só pra quem marcou agora (1 aviso por hora).
    async avisarLimite(contatoId) {
      const { rows } = await pool.query(
        `UPDATE ${S}.public_contacts SET limite_avisado_em = now()
          WHERE id = $1 AND (limite_avisado_em IS NULL OR limite_avisado_em < now() - interval '1 hour') RETURNING id`, [contatoId]);
      return rows.length > 0;
    },

    // Custo de modelo do atendimento público deste assistente desde a meia-noite (fuso).
    async gastoDoDia(agentId) {
      const { rows } = await pool.query(
        `SELECT coalesce(sum(cost_usd), 0)::float AS usd FROM ${S}.usage_events
          WHERE agent_id = $1 AND kind = 'publico'
            AND ts >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`, [agentId, fuso]);
      return rows[0].usd;
    },

    // LGPD: tudo o que existe de um contato (pedido de acesso do titular).
    async exportar(contatoId) {
      const { rows: [c] } = await pool.query(
        `SELECT id, agent_id, canal, endereco, criado_em, ultima_em, parado_em, bloqueado_em FROM ${S}.public_contacts WHERE id = $1`, [contatoId]);
      if (!c) return null;
      const { rows: msgs } = await pool.query(
        `SELECT role, content, criado_em FROM ${S}.public_messages WHERE contact_id = $1 ORDER BY id`, [contatoId]);
      const { rows: notas } = await pool.query(
        `SELECT chave, valor, atualizado_em FROM ${S}.public_contact_state WHERE contact_id = $1 ORDER BY chave`, [contatoId]);
      return {
        contato: { id: c.id, agentId: c.agent_id, canal: c.canal, endereco: decMaybe(c.endereco), criadoEm: c.criado_em, ultimaEm: c.ultima_em, paradoEm: c.parado_em, bloqueadoEm: c.bloqueado_em },
        anotacoes: notas.map((n) => ({ chave: n.chave, valor: n.valor, atualizadoEm: n.atualizado_em })),
        mensagens: msgs.map((m) => ({ role: m.role, content: m.content, criadoEm: m.criado_em })),
      };
    },

    // Apaga mensagens e anotações e mantém o contato (o bloqueio sobrevive).
    async apagarConversa(contatoId) {
      await transacao(async (c) => {
        await c.query(`DELETE FROM ${S}.public_messages WHERE contact_id = $1`, [contatoId]);
        await c.query(`DELETE FROM ${S}.public_contact_state WHERE contact_id = $1`, [contatoId]);
      });
    },

    // Visão do dono. Toda consulta daqui confere o dono no próprio SQL
    // (agents.user_id), então um id de outra conta devolve vazio, e não o dado.
    async agentesDoDono(userId) {
      const { rows } = await pool.query(
        `SELECT a.id AS agent_id, a.name AS nome, p.agent_id IS NOT NULL AS configurado, coalesce(p.ativo, false) AS ativo,
                coalesce(p.instrucoes, '') AS instrucoes, coalesce(p.retencao_dias, 90) AS retencao_dias,
                coalesce(p.limite_por_hora, ${LIMITE_POR_HORA}) AS limite_por_hora, p.teto_diario_usd::float AS teto_diario_usd,
                (SELECT count(*)::int FROM ${S}.public_contacts c WHERE c.agent_id = a.id) AS contatos
           FROM ${S}.agents a LEFT JOIN ${S}.public_agents p ON p.agent_id = a.id AND p.user_id = a.user_id
          WHERE a.user_id = $1 AND a.archived_at IS NULL ORDER BY a.name`, [userId]);
      return rows;
    },

    async contatoDoDono(userId, contatoId) {
      const { rows } = await pool.query(
        `SELECT c.id FROM ${S}.public_contacts c JOIN ${S}.agents a ON a.id = c.agent_id
          WHERE c.id = $1 AND a.user_id = $2`, [contatoId, userId]);
      return !!rows[0];
    },

    // Contatos de um assistente do dono, do mais recente pro mais antigo.
    // antes = ultima_em do último da página anterior.
    async contatosDoDono(userId, agentId, { antes = null, limite = CONTATOS_POR_PAGINA } = {}) {
      const { rows } = await pool.query(
        `SELECT c.id, c.canal, c.endereco, c.criado_em, c.ultima_em, c.parado_em, c.bloqueado_em,
                (SELECT count(*)::int FROM ${S}.public_messages m WHERE m.contact_id = c.id) AS mensagens
           FROM ${S}.public_contacts c JOIN ${S}.agents a ON a.id = c.agent_id
          WHERE c.agent_id = $1 AND a.user_id = $2 AND ($3::timestamptz IS NULL OR c.ultima_em < $3)
          ORDER BY c.ultima_em DESC LIMIT $4`, [agentId, userId, antes, Math.min(Math.max(1, limite | 0), CONTATOS_POR_PAGINA)]);
      return rows.map((r) => ({ id: r.id, canal: r.canal, endereco: decMaybe(r.endereco), criadoEm: r.criado_em, ultimaEm: r.ultima_em,
        paradoEm: r.parado_em, bloqueadoEm: r.bloqueado_em, mensagens: r.mensagens }));
    },

    // Conversa de um contato do dono, em ordem; antes = id da mensagem mais velha já vista.
    async conversaDoDono(userId, contatoId, { antes = null, limite = CONVERSA_POR_PAGINA } = {}) {
      const { rows } = await pool.query(
        `SELECT id, role, content, criado_em FROM (
           SELECT m.id, m.role, m.content, m.criado_em FROM ${S}.public_messages m
             JOIN ${S}.public_contacts c ON c.id = m.contact_id JOIN ${S}.agents a ON a.id = c.agent_id
            WHERE m.contact_id = $1 AND a.user_id = $2 AND ($3::bigint IS NULL OR m.id < $3)
            ORDER BY m.id DESC LIMIT $4) t ORDER BY id`,
        [contatoId, userId, antes, Math.min(Math.max(1, limite | 0), CONVERSA_POR_PAGINA)]);
      return rows.map((r) => ({ id: Number(r.id), role: r.role, content: r.content, criadoEm: r.criado_em }));
    },

    // LGPD: apaga o contato, as mensagens e as anotações (cascata).
    async apagarContato(contatoId) {
      const { rowCount } = await pool.query(`DELETE FROM ${S}.public_contacts WHERE id = $1`, [contatoId]);
      return rowCount > 0;
    },

    // Retenção (retencao_dias de cada assistente): apaga mensagem e anotação mais
    // velhas que o prazo e o contato sem conversa no prazo (com o telefone junto).
    // Contato bloqueado fica: sem a linha, o bloqueio sumiria e ele voltaria a ser atendido.
    // Em lotes, pra não segurar o banco; roda até esvaziar.
    async limparVencidos() {
      const total = { mensagens: 0, anotacoes: 0, contatos: 0 };
      const lote = async (sql) => { let n = 0, r; do { r = await pool.query(sql, []); n += r.rowCount ?? r.affectedRows ?? 0; } while ((r.rowCount ?? r.affectedRows) === LIMPEZA_LOTE); return n; };
      total.contatos = await lote(`DELETE FROM ${S}.public_contacts WHERE id IN (
        SELECT c.id FROM ${S}.public_contacts c JOIN ${S}.public_agents p ON p.agent_id = c.agent_id
         WHERE c.ultima_em < now() - p.retencao_dias * interval '1 day' AND c.bloqueado_em IS NULL LIMIT ${LIMPEZA_LOTE})`);
      total.mensagens = await lote(`DELETE FROM ${S}.public_messages WHERE id IN (
        SELECT m.id FROM ${S}.public_messages m JOIN ${S}.public_contacts c ON c.id = m.contact_id
          JOIN ${S}.public_agents p ON p.agent_id = c.agent_id
         WHERE m.criado_em < now() - p.retencao_dias * interval '1 day' LIMIT ${LIMPEZA_LOTE})`);
      total.anotacoes = await lote(`DELETE FROM ${S}.public_contact_state WHERE (contact_id, chave) IN (
        SELECT s.contact_id, s.chave FROM ${S}.public_contact_state s JOIN ${S}.public_contacts c ON c.id = s.contact_id
          JOIN ${S}.public_agents p ON p.agent_id = c.agent_id
         WHERE s.atualizado_em < now() - p.retencao_dias * interval '1 day' LIMIT ${LIMPEZA_LOTE})`);
      return total;
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
export const RESPOSTA_PARADO = 'Pronto, não vou mais responder por aqui. Se quiser voltar a falar comigo, mande VOLTAR. Para apagar o que ficou guardado desta conversa, mande APAGAR MEUS DADOS.';
export const RESPOSTA_VOLTOU = 'Oi de novo! Pode mandar sua mensagem.';
export const RESPOSTA_APAGADO = 'Apaguei as mensagens e as anotações desta conversa. Se você escrever de novo, começamos do zero.';
export const RESPOSTA_LIMITE = 'Recebi muitas mensagens em pouco tempo. Daqui a pouco volto a responder.';

// Comandos do contato, resolvidos ANTES do modelo (o modelo pode errar ou ser
// convencido a ignorar; isto não). Só a mensagem inteira conta: "quero parar de
// receber promoção" vai pro modelo, "parar" sozinho para.
const COMANDOS = {
  parar: ['parar', 'pare', 'sair', 'stop', 'unsubscribe'],
  voltar: ['voltar', 'start'],
  apagar: ['apagar meus dados', 'apague meus dados', 'excluir meus dados', 'exclua meus dados', 'delete my data'],
};
export function comandoDoContato(mensagem) {
  const t = String(mensagem || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [cmd, frases] of Object.entries(COMANDOS)) if (frases.includes(t)) return cmd;
  return null;
}

// deps (o servidor injeta):
//  store: createPublicoStore.
//  makeProvider({userId,agentId,contatoId}) → provider já preso ao gasto do dono.
//  recordUsage(usages,{userId,agentId,contatoId}) → grava o uso do turno.
//  saldo(userId) → {over}. over=true: responde a mensagem neutra, sem chamar modelo.
//  ferramentas: porta de ferramentas (doTurno/vetar/instrucoes); só entram as
//   tools com publico:true, e doTurno recebe o contato.
//  agora() → data e hora por extenso pro prompt.
//  gastoDoDia(agentId) → US$ do atendimento público hoje (padrão: store.gastoDoDia).
//  ganchos: porta atendimentoPublico de plugin (roteiro de quem atende), opcional:
//   antesDoModelo(ctx) → {instrucoes?, saidas?, pular?}. instrucoes troca as do
//    dono só neste turno; pular com saidas responde sem chamar o modelo (abertura,
//    resposta fixa).
//   depoisDoModelo({...ctx, texto}) → {saidas?}: troca o texto do modelo por
//    saídas ricas (publico-saidas.mjs).
//   ctx = {agente:{agentId,nome}, contato:{id,canal,endereco}, canal, mensagem,
//    primeira (histórico vazio), estado(), lembrar(chave,valor)}.
//   Gancho que falha ou devolve lixo é ignorado: o turno segue como sem plugin.
//
// O turno devolve {text, saidas?, motivo?, userId, agentId, contatoId}. Com
// saidas, text é a versão em texto delas (canal que não entrega o tipo rico).
//
// Ordem dos freios, antes do modelo: contato bloqueado pelo dono (silêncio) →
// comando do contato (parar/voltar/apagar) →
// contato parado (silêncio, nada gravado) → limite por hora do contato (1 aviso
// por hora, depois silêncio) → saldo do dono → teto diário do assistente.
export function createAtendimentoPublico({ store, makeProvider, recordUsage, saldo, ferramentas, agora = () => '', gastoDoDia = (id) => store.gastoDoDia(id), runAgent = runAgentPadrao, ganchos = null, log = console }) {
  async function gancho(nome, ctx) {
    if (typeof ganchos?.[nome] !== 'function') return null;
    try { const r = await ganchos[nome](ctx); return r && typeof r === 'object' ? r : null; }
    catch (e) { log.error?.(`[publico] gancho ${nome} falhou:`, e?.message ?? e); return null; }
  }

  const filas = new Map(); // contato (assistente+canal+endereço) → turno em andamento (1 por contato)
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
    const msg = texto(mensagem, MENSAGEM_MAX);
    // O contato é lido DENTRO da fila: um "apagar meus dados" na frente apaga a
    // linha, e o turno seguinte começa num contato novo.
    return emFila(`${agentId}:${canal}:${texto(endereco, 200)}`, async () => {
      const contato = await store.contato(agentId, canal, endereco);
      const ident = { userId: agente.user_id, agentId: agente.agent_id, contatoId: contato.id };
      if (!msg) return { text: null, motivo: 'vazia', ...ident };
      const comando = comandoDoContato(msg);
      // Bloqueado pelo dono: silêncio e nada gravado. O pedido de apagar ainda
      // vale (apaga a conversa), mas o contato fica, senão o bloqueio sumiria junto.
      if (contato.bloqueadoEm) {
        if (comando === 'apagar') await store.apagarConversa(contato.id);
        return { text: null, motivo: 'bloqueado', ...ident };
      }
      if (comando === 'apagar') {
        await store.apagarContato(contato.id);
        return { text: RESPOSTA_APAGADO, motivo: 'apagado', ...ident, contatoId: null };
      }
      if (comando === 'parar') { await store.parar(contato.id, true); return { text: RESPOSTA_PARADO, motivo: 'parado', ...ident }; }
      if (contato.paradoEm) {
        if (comando !== 'voltar') return { text: null, motivo: 'parado', ...ident };
        await store.parar(contato.id, false);
        return { text: RESPOSTA_VOLTOU, motivo: 'voltou', ...ident };
      }
      if (await store.mensagensNaUltimaHora(contato.id) >= agente.limite_por_hora) {
        const avisar = await store.avisarLimite(contato.id);
        return { text: avisar ? RESPOSTA_LIMITE : null, motivo: 'limite', ...ident };
      }
      const indisponivel = async (motivo) => {
        await store.registrar(contato.id, [{ role: 'user', content: msg }, { role: 'assistant', content: RESPOSTA_INDISPONIVEL }]);
        return { text: RESPOSTA_INDISPONIVEL, motivo, ...ident };
      };
      const credito = await saldo(agente.user_id);
      if (!credito || credito.over !== false) return indisponivel('sem_saldo');
      if (agente.teto_diario_usd != null && await gastoDoDia(agente.agent_id) >= agente.teto_diario_usd) return indisponivel('teto_diario');
      const history = await store.historico(contato.id);
      const ctx = { agente: { agentId: agente.agent_id, nome: agente.nome }, contato: { id: contato.id, canal: contato.canal, endereco: contato.endereco },
        canal, mensagem: msg, primeira: !history.length,
        estado: () => store.estado(contato.id), lembrar: (chave, valor) => store.lembrar(contato.id, chave, valor) };
      const antes = await gancho('antesDoModelo', ctx);
      const prontas = normalizarSaidas(antes?.saidas);
      if (antes?.pular === true && prontas.length) {
        const text = textoDasSaidas(prontas);
        await store.registrar(contato.id, [{ role: 'user', content: msg }, { role: 'assistant', content: text }]);
        return { text, saidas: prontas, motivo: 'roteiro', ...ident };
      }
      const tools = registro(agente, contato, msg);
      const system = promptPublico({ nome: agente.nome, instrucoes: typeof antes?.instrucoes === 'string' ? antes.instrucoes : agente.instrucoes,
        canal, agora: agora(), instrucoesExtras: ferramentas?.instrucoes(new Set(tools.map.keys())) || [] });
      let text = '';
      try {
        const r = await runAgent({ provider: makeProvider(ident), tools, system, userInput: msg, history, maxSteps: PASSOS_MAX });
        await recordUsage(r.usages || [], ident);
        text = typeof r.text === 'string' ? r.text.trim() : '';
      } catch (e) {
        log.error?.('[publico] turno falhou:', e?.message ?? e);
      }
      if (!text) {
        await store.registrar(contato.id, [{ role: 'user', content: msg }, { role: 'assistant', content: RESPOSTA_INDISPONIVEL }]);
        return { text: RESPOSTA_INDISPONIVEL, ...ident };
      }
      const saidas = normalizarSaidas((await gancho('depoisDoModelo', { ...ctx, texto: text }))?.saidas);
      if (saidas.length) text = textoDasSaidas(saidas);
      await store.registrar(contato.id, [{ role: 'user', content: msg }, { role: 'assistant', content: text }]);
      return { text, ...(saidas.length ? { saidas } : {}), ...ident };
    });
  }

  return { turno, registro };
}
