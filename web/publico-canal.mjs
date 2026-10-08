// Connects public support (publico.mjs) to the server and to WhatsApp.
//
// Phase 1 uses the installation's single number. Whoever installs it chooses WHICH assistant
// handles those without an account (ATENDIMENTO_PUBLICO_AGENTE = agent id); the owner
// of that assistant turns it on and off in public_agents.ativo. Without the variable, or with
// support turned off, nothing changes: an unlinked number keeps receiving the
// login message. The choice belongs to the installation, not to each user, because the
// number is a single one: if any owner could turn it on, every stranger would go to
// their assistant.
import { randomUUID } from 'node:crypto';
import { createPublicoStore, createAtendimentoPublico, esquemaPublico } from './publico.mjs';
import { registrarRotasDoDono } from './publico-dono.mjs';

const LIMPEZA_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Joins the initDb schema list.
export const esquemaDoAtendimento = async ({ pool, S }) => { await pool.query(esquemaPublico(S)); };

export const agentePublicoDoNumero = (valor = process.env.ATENDIMENTO_PUBLICO_AGENTE) => {
  const id = String(valor || '').trim();
  return UUID.test(id) ? id : null;
};

const agoraPorExtenso = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// deps: database pool/S; makeProvider(ident) already tied to the owner's spend;
// recordUsages and creditStatus from the server; ferramentas = tools port;
// ganchos = plugin's atendimentoPublico port (script; see publico.mjs).
// Returns what the WhatsApp channel uses: atende() says whether support is on
// for the number; turno({endereco,mensagem}) → {text,saidas?,userId,agentId}.
// Retention (deleting what's past retencao_dias) runs on its own every
// limpezaMs, the first one a minute after boot; limpezaMs=0 turns it off.
// With routes (+ send/fail/tooManyRequests from the server), registers the owner's view
// (publico-dono.mjs).
export function criarAtendimentoDoServidor({ pool, S, makeProvider, recordUsages, creditStatus, ferramentas, ganchos = null, agenteDoNumero = () => agentePublicoDoNumero(), log = console, limpezaMs = LIMPEZA_MS,
  rotas, send, fail, tooManyRequests }) {
  const store = createPublicoStore(pool, { S });
  if (rotas) registrarRotasDoDono({ rotas, store, send, fail, tooManyRequests, agenteDoNumero });
  const limpar = async () => {
    try {
      const r = await store.limparVencidos();
      if (r.mensagens || r.anotacoes || r.contatos) log.log?.(`[publico] retenção: ${r.contatos} contato(s), ${r.mensagens} mensagem(ns), ${r.anotacoes} anotação(ões) apagadas`);
    } catch (e) { log.error?.('[publico] retenção falhou:', e?.message ?? e); }
  };
  if (limpezaMs > 0) {
    setTimeout(limpar, Math.min(60_000, limpezaMs)).unref?.();
    setInterval(limpar, limpezaMs).unref?.();
  }
  const atendimento = createAtendimentoPublico({
    store, makeProvider, ferramentas, ganchos, log, agora: agoraPorExtenso,
    saldo: creditStatus,
    recordUsage: (usages, { userId, agentId }) => recordUsages(usages, { userId, agentId, threadId: null, turnId: randomUUID(), kind: 'publico' }),
  });
  return {
    store, limpar,
    whatsapp: {
      async atende() { const id = agenteDoNumero(); return !!id && !!(await store.agente(id))?.ativo; },
      turno: ({ endereco, mensagem }) => atendimento.turno({ agentId: agenteDoNumero(), canal: 'whatsapp', endereco, mensagem }),
    },
  };
}
