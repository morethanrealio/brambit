// ── Spaces: assunto vivo compartilhado, sem App/runtime ──
// O degrau do meio da escada de primitivas (Skill / Space / App). Um Space =
// definição em linguagem natural (`about`, faz o papel do SKILL.md) + dado vivo
// compartilhado (`space_entries`) + membros (donos conectados). ZERO container,
// host, deploy ou quota. Reusa agent_connections (gate de convite), o padrão de
// roster do app_collab e o inbox/notifyOwner. Ver projetos/espaco-implementacao.md.

import {
  createSpace, listSpacesForUser, resolveSpace, addSpaceEntry, listSpaceEntries,
  listSpaceMembers, addSpaceMember, removeSpaceMember, resolveConnectedUser, contatoAmbiguoMsg,
  getSpaceEntry, updateSpaceEntry, deleteSpaceEntry, setSpaceMode,
} from './db.mjs';
import { cartaoEdicaoNota } from './nota-diff.mjs';

// Tools do assistente pra ESTE usuário (entram no registry por requisição).
// `convidar_para_espaco` sai daqui e é registrada GATED em server.mjs.
export function spacesTools(userId, agentId) {
  // editar_nota: o mesmo alvo e as mesmas permissões valem pro cartão e pra
  // gravação, então a checagem fica num lugar só.
  async function notaEditavel({ espaco, nota_id, dono } = {}) {
    const r = await resolveSpace(userId, espaco, dono);
    if (r.error === 'espaco_nao_encontrado') return { erro: `Não achei um Space "${espaco}".` };
    if (r.error === 'ambiguo') return { erro: `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}" (de ${o.owner})`).join(', ')}. Diga o dono.` };
    if (r.error) return { erro: `Não consegui abrir o Space (${r.error}).` };
    const entry = await getSpaceEntry(nota_id, r.space.id);
    if (!entry) return { erro: 'Não achei essa anotação no Space. Confira o id com ler_espaco.' };
    if (entry.authorUserId !== userId && !r.space.isOwner) return { erro: 'Só quem escreveu a nota ou o dono do Space pode editá-la.' };
    return { space: r.space, entry };
  }
  async function gravarNota({ nota_id, nova_nota, tag }, space) {
    const up = await updateSpaceEntry(nota_id, space.id, { body: nova_nota, tag });
    if (up.error === 'nada_pra_mudar') return 'Diga o novo texto ou a nova tag pra eu editar.';
    if (up.error) return `Não consegui editar (${up.error}).`;
    return `Anotação atualizada no Space "${space.title}".`;
  }
  return [
    {
      name: 'criar_espaco',
      description: 'Cria um Space: um assunto vivo compartilhável (ex: "plantas", "compras de casa", "viagem ao Chile") onde você e as pessoas que convidar mantêm informação junto, sem precisar de um App com site/código. Use quando o usuário quiser organizar/trocar informação sobre um tema ao longo do tempo. Não é gated (o Space nasce só seu; convidar alguém é outra ação).',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome curto do Space, ex: "plantas".' },
          sobre: { type: 'string', description: 'Do que trata e como você deve se comportar nesse assunto (o "manual" do Space). Opcional mas recomendado.' },
        },
        required: ['nome'],
      },
      async run({ nome, sobre }) {
        const r = await createSpace(userId, { nome, sobre }, agentId);
        if (r.error === 'nome_vazio') return 'Preciso de um nome pro Space.';
        if (r.error === 'ja_existe') return `Você já tem um Space "${nome}". Use ler_espaco ou anotar_no_espaco nele.`;
        return `Space "${r.title}" criado. Agora dá pra anotar nele (anotar_no_espaco) e, quando quiser, convidar alguém conectado (convidar_para_espaco).`;
      },
    },
    {
      name: 'listar_espacos',
      description: 'Lista os Spaces que você mantém (seus) e os que participa (de contatos que te convidaram), com um resumo de cada e quantas anotações tem.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const spaces = await listSpacesForUser(userId);
        if (!spaces.length) return 'Nenhum Space ainda. Crie um com criar_espaco.';
        return JSON.stringify(spaces.map((s) => ({
          nome: s.title,
          sobre: s.about || undefined,
          dono: s.isOwner ? 'você' : s.ownerName,
          anotacoes: s.entries,
          modo: s.shareMode,
        })));
      },
    },
    {
      name: 'ler_espaco',
      description: 'Lê um Space: o que ele trata, quem participa e as últimas anotações. Use antes de responder algo sobre o assunto do Space, pra puxar o dado vivo sob demanda.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do Space.' },
          dono: { type: 'string', description: 'Se for Space de um contato (não seu), o nome ou e-mail do dono pra desambiguar. Opcional.' },
        },
        required: ['espaco'],
      },
      async run({ espaco, dono }) {
        const r = await resolveSpace(userId, espaco, dono);
        if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}" seu ou de um contato.`;
        if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}" (de ${o.owner})`).join(', ')}. Diga o dono.`;
        if (r.error) return `Não consegui abrir o Space (${r.error}).`;
        const s = r.space;
        const [entries, members] = await Promise.all([
          listSpaceEntries(s.id, 50), listSpaceMembers(s.id),
        ]);
        return JSON.stringify({
          nome: s.title,
          sobre: s.about || undefined,
          dono: s.isOwner ? 'você' : s.ownerName,
          modo: s.shareMode,
          membros: members.map((m) => (m.isOwner ? `${m.name} (dono)` : m.name)),
          anotacoes: entries.map((e) => ({
            id: e.id, quando: e.createdAt, autor: e.author, tag: e.tag || undefined, nota: e.body,
          })),
        });
      },
    },
    {
      name: 'anotar_no_espaco',
      description: 'Grava uma anotação no dado vivo de um Space. ATENÇÃO: escrever aqui é PUBLICAR pra todos os membros do Space (é dado compartilhado, não sua memória privada). Por isso o padrão é NÃO anotar: conversar sobre o tema, discutir cuidados, tirar dúvida ou aprender sobre o assunto fica na conversa privada e NÃO entra no Space. Só use quando (a) o usuário pedir pra registrar/compartilhar, ou (b) for claramente um FATO ou ESTADO compartilhado do assunto real do Space (ex: "temos uma jiboia nova", "reguei hoje", "comprar adubo", uma decisão do casal). Nunca jogue opinião, reflexão ou papo geral aqui. Ao anotar, diga na resposta o que você anotou, pra ficar visível pro usuário. Não é gated (pra não atrapalhar), então a responsabilidade de filtrar é sua.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do Space.' },
          nota: { type: 'string', description: 'A informação a registrar, em linguagem natural.' },
          tag: { type: 'string', description: 'Rótulo curto opcional pra agrupar (ex: "rega", "compras").' },
          dono: { type: 'string', description: 'Se for Space de um contato, o dono pra desambiguar. Opcional.' },
        },
        required: ['espaco', 'nota'],
      },
      async run({ espaco, nota, tag, dono }) {
        const r = await resolveSpace(userId, espaco, dono);
        if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}".`;
        if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}" (de ${o.owner})`).join(', ')}. Diga o dono.`;
        if (r.error) return `Não consegui abrir o Space (${r.error}).`;
        const e = await addSpaceEntry(r.space.id, userId, agentId, { body: nota, tag });
        if (e.error === 'nota_vazia') return 'A anotação está vazia.';
        return `Anotado no Space "${r.space.title}".`;
      },
    },
    {
      name: 'configurar_espaco',
      description: 'Ajusta o MODO de compartilhamento de um Space seu: "auto" (você, o assistente, decide o que registrar: fato/estado compartilhado ou a pedido) ou "manual" (você NUNCA anota por conta própria; só registra quando o dono pedir explicitamente "anota isso no Space"). Só o dono do Space muda o modo. Também dá pra mudar na seção Spaces (dentro da aba Conexões) da interface.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do Space.' },
          modo: { type: 'string', enum: ['auto', 'manual'], description: '"auto" = o assistente decide; "manual" = só anota a pedido explícito.' },
        },
        required: ['espaco', 'modo'],
      },
      async run({ espaco, modo }) {
        const r = await resolveSpace(userId, espaco);
        if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}" seu.`;
        if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}" (de ${o.owner})`).join(', ')}.`;
        if (r.error) return `Não consegui abrir o Space (${r.error}).`;
        if (!r.space.isOwner) return `Só o dono do Space pode mudar o modo. "${r.space.title}" é de ${r.space.ownerName}.`;
        const res = await setSpaceMode(r.space.id, userId, modo);
        if (res.error === 'nao_e_dono') return 'Só o dono pode mudar o modo do Space.';
        return res.mode === 'manual'
          ? `Modo do Space "${r.space.title}" agora é MANUAL: eu só vou anotar quando você pedir explicitamente.`
          : `Modo do Space "${r.space.title}" agora é AUTO: eu registro fato/estado compartilhado sozinho (e sempre te aviso o que anotei).`;
      },
    },
    {
      name: 'editar_nota',
      description: 'Edita uma anotação existente de um Space (corrige o texto ou muda a tag). O nota_id vem do campo "id" que ler_espaco devolve em cada anotação. Só o autor da nota ou o dono do Space pode editar.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do Space.' },
          nota_id: { type: 'string', description: 'O id da anotação (campo "id" retornado por ler_espaco).' },
          nova_nota: { type: 'string', description: 'Novo texto da anotação. Opcional se só for mudar a tag.' },
          tag: { type: 'string', description: 'Nova tag. Opcional.' },
          dono: { type: 'string', description: 'Se for Space de um contato, o dono pra desambiguar. Opcional.' },
        },
        required: ['espaco', 'nota_id'],
      },
      // Duas propostas pendentes pra MESMA nota não fazem sentido: a nova
      // substitui a anterior (confirm.mjs). Sem isso cada correção da pessoa
      // virava mais um cartão empilhado (30/09/2026).
      supersedeKey: ({ nota_id } = {}) => String(nota_id || '').trim() || null,
      // O cartão mostra só as linhas que mudam em relação à nota GRAVADA agora.
      // Como o texto do cartão sai desta leitura, se a nota mudar antes da
      // aprovação o cartão recalculado não bate e a proposta é invalidada, em
      // vez de gravar por cima de uma versão que a pessoa não viu.
      async prepareConfirmation(args = {}) {
        const alvo = await notaEditavel(args);
        if (alvo.erro) throw Error(alvo.erro);
        const cartao = cartaoEdicaoNota({ espaco: alvo.space.title, antes: alvo.entry.body,
          depois: args.nova_nota, tagAntes: alvo.entry.tag, tagDepois: args.tag });
        const base = alvo.entry.body;
        return { ...cartao, run: async () => {
          const agora = await notaEditavel(args);
          if (agora.erro) return agora.erro;
          if (agora.entry.body !== base) return 'Não alterei nada: a nota mudou depois que a proposta foi montada. Leia a nota de novo e proponha a edição outra vez.';
          return gravarNota(args, agora.space);
        } };
      },
      async run(args) {
        const alvo = await notaEditavel(args);
        if (alvo.erro) return alvo.erro;
        return gravarNota(args, alvo.space);
      },
    },
    {
      name: 'apagar_nota',
      description: 'Apaga uma anotação de um Space. O nota_id vem do campo "id" que ler_espaco devolve. Só o autor da nota ou o dono do Space pode apagar.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do Space.' },
          nota_id: { type: 'string', description: 'O id da anotação (campo "id" retornado por ler_espaco).' },
          dono: { type: 'string', description: 'Se for Space de um contato, o dono pra desambiguar. Opcional.' },
        },
        required: ['espaco', 'nota_id'],
      },
      async run({ espaco, nota_id, dono }) {
        const r = await resolveSpace(userId, espaco, dono);
        if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}".`;
        if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}" (de ${o.owner})`).join(', ')}. Diga o dono.`;
        if (r.error) return `Não consegui abrir o Space (${r.error}).`;
        const entry = await getSpaceEntry(nota_id, r.space.id);
        if (!entry) return 'Não achei essa anotação no Space. Confira o id com ler_espaco.';
        if (entry.authorUserId !== userId && !r.space.isOwner) return 'Só quem escreveu a nota ou o dono do Space pode apagá-la.';
        const n = await deleteSpaceEntry(r.space.id, nota_id);
        return n ? `Anotação apagada do Space "${r.space.title}".` : 'Nada foi apagado (a anotação já não existia).';
      },
    },
    {
      name: 'sair_do_espaco',
      description: 'Sai de um Space do qual você é MEMBRO (deixa de ver e anotar nele). O dono não pode sair do próprio Space; nesse caso o Space teria que ser apagado (não suportado ainda).',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do Space.' },
          dono: { type: 'string', description: 'O dono do Space, pra desambiguar (já que é um Space de outra pessoa).' },
        },
        required: ['espaco'],
      },
      async run({ espaco, dono }) {
        const r = await resolveSpace(userId, espaco, dono);
        if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}".`;
        if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}" (de ${o.owner})`).join(', ')}. Diga o dono.`;
        if (r.error) return `Não consegui abrir o Space (${r.error}).`;
        if (r.space.isOwner) return 'Você é o dono desse Space, então não dá pra "sair" dele. (Apagar o Space ainda não é suportado.)';
        await removeSpaceMember(r.space.id, userId);
        return `Você saiu do Space "${r.space.title}". Não vê mais as anotações dele.`;
      },
    },
    {
      name: 'remover_do_espaco',
      description: 'Remove um membro de um Space SEU (ele deixa de ver e anotar). Só o dono do Space pode remover gente.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Nome do seu Space.' },
          contato: { type: 'string', description: 'Nome ou e-mail do membro a remover.' },
        },
        required: ['espaco', 'contato'],
      },
      async run({ espaco, contato }) {
        const r = await resolveSpace(userId, espaco);
        if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}" seu.`;
        if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}"`).join(', ')}. Seja específico.`;
        if (r.error) return `Não consegui abrir o Space (${r.error}).`;
        if (!r.space.isOwner) return 'Só o dono do Space pode remover membros.';
        const who = await resolveConnectedUser(userId, contato);
        if (who.error === 'contato_nao_encontrado') return `Não achei "${contato}" entre seus contatos.`;
        if (who.error === 'contato_ambiguo') return contatoAmbiguoMsg(contato, who.opcoes);
        if (who.error) return `Não consegui resolver o contato (${who.error}).`;
        if (who.userId === userId) return 'Você é o dono; não dá pra se remover.';
        const n = await removeSpaceMember(r.space.id, who.userId);
        return n ? `${who.name} foi removido do Space "${r.space.title}".` : `${who.name} já não participava do Space.`;
      },
    },
  ];
}

// Tool GATED (alcança outra pessoa) — registrada via addGated em server.mjs.
// Reversível (dá pra remover/sair) → 👍-confirmável, igual convidar_colaborador.
export function spaceInviteTool(userId, agentId) {
  return {
    name: 'convidar_para_espaco',
    description: 'Convida um contato conectado a participar de um Space SEU (ele passa a ver e anotar no dado vivo do Space). Precisa de conexão aceita entre vocês. Ação sensível: alcança outra pessoa, então passa por confirmação.',
    parameters: {
      type: 'object',
      properties: {
        espaco: { type: 'string', description: 'Nome do seu Space.' },
        contato: { type: 'string', description: 'Nome ou e-mail do contato conectado a convidar.' },
      },
      required: ['espaco', 'contato'],
    },
    async run({ espaco, contato }) {
      const r = await resolveSpace(userId, espaco);
      if (r.error === 'espaco_nao_encontrado') return `Não achei um Space "${espaco}" seu.`;
      if (r.error === 'ambiguo') return `Tem mais de um Space parecido: ${r.options.map((o) => `"${o.title}"`).join(', ')}. Seja específico.`;
      if (r.error) return `Não consegui abrir o Space (${r.error}).`;
      if (!r.space.isOwner) return 'Só o dono do Space pode convidar gente.';
      const who = await resolveConnectedUser(userId, contato);
      if (who.error === 'contato_nao_encontrado') return `Não achei "${contato}" entre seus contatos conectados. Conecte-se primeiro.`;
      if (who.error === 'contato_ambiguo') return contatoAmbiguoMsg(contato, who.opcoes);
      if (who.error) return `Não consegui resolver o contato (${who.error}).`;
      await addSpaceMember(r.space.id, who.userId, agentId);
      // Aviso proativo ao outro dono (best-effort; notifyOwner é da Yume/Fase notify).
      try {
        const { notifyOwner } = await import('./notify.mjs').catch(() => ({}));
        await notifyOwner?.(who.userId, `Você foi adicionado ao Space "${r.space.title}". Seu assistente já pode ver e anotar nele.`);
      } catch { /* silencioso: o convite vale mesmo sem push */ }
      return `Pronto, ${who.name} agora participa do Space "${r.space.title}". O assistente dele já enxerga o Space.`;
    },
  };
}

// Texto pro system prompt: índice compacto dos Spaces do usuário (progressive
// disclosure). As anotações NÃO entram aqui; carregam sob demanda via ler_espaco.
export async function spacesContext(userId) {
  const spaces = await listSpacesForUser(userId);
  if (!spaces.length) return '';
  const lines = [
    'Spaces que você mantém (assuntos vivos COMPARTILHADOS com outras pessoas). Ao falar com o usuário, chame isto de "Space" (plural "Spaces"), nunca "espaço". REGRA IMPORTANTE: conversar sobre o tema é PRIVADO por padrão. Discutir cuidados, tirar dúvidas ou aprender sobre o assunto NÃO vai pro Space. Use ler_espaco pra puxar o dado atual quando for útil responder. Ao anotar, avise o usuário do que você registrou. Cada Space tem um MODO que define quando você anota (Space novo nasce em MANUAL):',
    '• modo AUTO — anote com anotar_no_espaco quando (a) o usuário pedir, ou (b) surgir um FATO ou ESTADO claramente compartilhado do assunto real (ex: "temos uma jiboia nova", "reguei hoje", "comprar adubo"). Nunca opinião, papo ou reflexão.',
    '• modo MANUAL — NÃO anote nada por conta própria em hipótese alguma; só chame anotar_no_espaco quando o usuário pedir explicitamente pra registrar ("anota isso no Space", "salva pra Ana ver").',
  ];
  for (const s of spaces) {
    const dono = s.isOwner ? 'seu' : `de ${s.ownerName}`;
    const modo = s.shareMode === 'manual' ? 'MANUAL' : 'AUTO';
    const sobre = s.about ? ` — ${s.about.slice(0, 120)}` : '';
    lines.push(`• ${s.title} [${modo}] (${dono}, ${s.entries} anotações)${sobre}`);
  }
  return lines.join('\n');
}
