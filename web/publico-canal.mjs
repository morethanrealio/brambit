// Liga o atendimento ao público (publico.mjs) ao servidor e ao WhatsApp.
//
// Fase 1 usa o número único da instalação. Quem instala escolhe QUAL assistente
// atende quem não tem conta (ATENDIMENTO_PUBLICO_AGENTE = id do agente); o dono
// desse assistente liga e desliga em public_agents.ativo. Sem a variável, ou com
// o atendimento desligado, nada muda: número não vinculado segue recebendo a
// mensagem de login. A escolha é da instalação, e não de cada usuário, porque o
// número é um só: se qualquer dono pudesse ligar, todo desconhecido iria pro
// assistente dele.
import { randomUUID } from 'node:crypto';
import { createPublicoStore, createAtendimentoPublico, esquemaPublico } from './publico.mjs';

const LIMPEZA_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Entra na lista de esquemas do initDb.
export const esquemaDoAtendimento = async ({ pool, S }) => { await pool.query(esquemaPublico(S)); };

export const agentePublicoDoNumero = (valor = process.env.ATENDIMENTO_PUBLICO_AGENTE) => {
  const id = String(valor || '').trim();
  return UUID.test(id) ? id : null;
};

const agoraPorExtenso = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// deps: pool/S do banco; makeProvider(ident) já preso ao gasto do dono;
// recordUsages e creditStatus do servidor; ferramentas = porta de ferramentas.
// Devolve o que o canal do WhatsApp usa: atende() diz se há atendimento ligado
// pro número; turno({endereco,mensagem}) → {text,userId,agentId}.
// A retenção (apagar o que passou de retencao_dias) roda sozinha a cada
// limpezaMs, a primeira um minuto depois do boot; limpezaMs=0 desliga.
export function criarAtendimentoDoServidor({ pool, S, makeProvider, recordUsages, creditStatus, ferramentas, agenteDoNumero = () => agentePublicoDoNumero(), log = console, limpezaMs = LIMPEZA_MS }) {
  const store = createPublicoStore(pool, { S });
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
    store, makeProvider, ferramentas, log, agora: agoraPorExtenso,
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
