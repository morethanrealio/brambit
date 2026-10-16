// ── Spaces: shared live subject, no App/runtime ──
// The middle step of the primitive ladder (Skill / Space / App). A Space =
// natural-language definition (`about`, plays the role of the SKILL.md) + shared
// live data (`space_entries`) + members (connected owners). ZERO container,
// host, deploy or quota. Reuses agent_connections (invite gate), the app_collab's
// roster pattern and the inbox/notifyOwner. See projetos/espaco-implementacao.md.

import {
  createSpace, listSpacesForUser, resolveSpace, addSpaceEntry, listSpaceEntries,
  listSpaceMembers, addSpaceMember, removeSpaceMember, resolveConnectedUser, contatoAmbiguoMsg,
  getSpaceEntry, updateSpaceEntry, deleteSpaceEntry, setSpaceMode,
} from './db.mjs';
import { cartaoEdicaoNota } from './nota-diff.mjs';

// Assistant tools for THIS user (enter the registry on request).
// `convidar_para_espaco` comes out of here and is registered GATED in server.mjs.
export function spacesTools(userId, agentId) {
  // editar_nota: the same target and the same permissions apply to the card and to the
  // write, so the check lives in one place.
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
      description: 'Creates a Space: a shareable living topic (e.g. "plantas", "compras de casa", "viagem ao Chile") where you and the people you invite keep information together, without needing an App with a site/code. Use when the user wants to organize/exchange information about a topic over time. Not gated (the Space starts out yours only; inviting someone is a separate action).',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Short Space name, e.g. "plantas".' },
          sobre: { type: 'string', description: 'What it is about and how you should behave on this topic (the Space\'s "manual"). Optional but recommended.' },
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
      description: 'Lists the Spaces you keep (yours) and the ones you take part in (from contacts who invited you), with a summary of each and how many notes it has.',
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
      description: 'Reads a Space: what it is about, who takes part and the latest notes. Use before answering something about the Space\'s topic, to pull the live data on demand.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Space name.' },
          dono: { type: 'string', description: 'If it is a contact\'s Space (not yours), the owner\'s name or e-mail to disambiguate. Optional.' },
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
      description: 'Writes a note to a Space\'s live data. WARNING: writing here is PUBLISHING to all Space members (it is shared data, not your private memory). So the default is to NOT write: talking about the topic, discussing care, answering questions or learning about the subject stays in the private conversation and does NOT go into the Space. Only use it when (a) the user asks to record/share, or (b) it is clearly a shared FACT or STATE of the Space\'s actual topic (e.g. "temos uma jiboia nova", "reguei hoje", "comprar adubo", a decision by the couple). Never put opinion, reflection or general chat here. When you write a note, say in the reply what you noted, so it is visible to the user. Not gated (so it does not get in the way), so filtering is your responsibility.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Space name.' },
          nota: { type: 'string', description: 'The information to record, in natural language.' },
          tag: { type: 'string', description: 'Optional short label for grouping (e.g. "rega", "compras").' },
          dono: { type: 'string', description: 'If it is a contact\'s Space, the owner to disambiguate. Optional.' },
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
      description: 'Sets the sharing MODE of a Space of yours: "auto" (you, the assistant, decide what to record: shared fact/state or on request) or "manual" (you NEVER write on your own; only record when the owner explicitly asks "anota isso no Space"). Only the Space owner changes the mode. It can also be changed in the Spaces section (inside the Conexões tab) of the interface.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Space name.' },
          modo: { type: 'string', enum: ['auto', 'manual'], description: '"auto" = the assistant decides; "manual" = only writes on explicit request.' },
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
      description: 'Edits an existing note in a Space (fixes the text or changes the tag). The nota_id comes from the "id" field that ler_espaco returns for each note. Only the note\'s author or the Space owner can edit.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Space name.' },
          nota_id: { type: 'string', description: 'The note id ("id" field returned by ler_espaco).' },
          nova_nota: { type: 'string', description: 'New note text. Optional if only changing the tag.' },
          tag: { type: 'string', description: 'New tag. Optional.' },
          dono: { type: 'string', description: 'If it is a contact\'s Space, the owner to disambiguate. Optional.' },
        },
        required: ['espaco', 'nota_id'],
      },
      // Two pending proposals for the SAME note don't make sense: the new one
      // replaces the earlier one (confirm.mjs). Without this every correction by the
      // person became yet another stacked card (2026-09-30).
      supersedeKey: ({ nota_id } = {}) => String(nota_id || '').trim() || null,
      // The card shows only the lines that change relative to the note as STORED now.
      // Since the card's text comes from this read, if the note changes before
      // approval the recalculated card doesn't match and the proposal is invalidated, instead
      // of writing over a version the person never saw.
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
      description: 'Deletes a note from a Space. The nota_id comes from the "id" field that ler_espaco returns. Only the note\'s author or the Space owner can delete.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Space name.' },
          nota_id: { type: 'string', description: 'The note id ("id" field returned by ler_espaco).' },
          dono: { type: 'string', description: 'If it is a contact\'s Space, the owner to disambiguate. Optional.' },
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
      description: 'Leaves a Space you are a MEMBER of (stops seeing and writing to it). The owner cannot leave their own Space; in that case the Space would have to be deleted (not supported yet).',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Space name.' },
          dono: { type: 'string', description: 'The Space owner, to disambiguate (since it is someone else\'s Space).' },
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
      description: 'Removes a member from a Space of YOURS (they stop seeing and writing). Only the Space owner can remove people.',
      parameters: {
        type: 'object',
        properties: {
          espaco: { type: 'string', description: 'Name of your Space.' },
          contato: { type: 'string', description: 'Name or e-mail of the member to remove.' },
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

// GATED tool (reaches another person) — registered via addGated in server.mjs.
// Reversible (can remove/leave) → 👍-confirmable, same as convidar_colaborador.
export function spaceInviteTool(userId, agentId) {
  return {
    name: 'convidar_para_espaco',
    description: 'Invites a connected contact to join a Space of YOURS (they start seeing and writing to the Space\'s live data). Requires an accepted connection between you. Sensitive action: it reaches another person, so it goes through confirmation.',
    parameters: {
      type: 'object',
      properties: {
        espaco: { type: 'string', description: 'Name of your Space.' },
        contato: { type: 'string', description: 'Name or e-mail of the connected contact to invite.' },
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
      // Proactive notice to the other owner (best-effort; notifyOwner comes from notify.mjs).
      try {
        const { notifyOwner } = await import('./notify.mjs').catch(() => ({}));
        await notifyOwner?.(who.userId, `Você foi adicionado ao Space "${r.space.title}". Seu assistente já pode ver e anotar nele.`);
      } catch { /* silent: the invitation counts even without a push */ }
      return `Pronto, ${who.name} agora participa do Space "${r.space.title}". O assistente dele já enxerga o Space.`;
    },
  };
}

// Text for the system prompt: compact index of the user's Spaces (progressive
// disclosure). The notes do NOT go in here; they load on demand via ler_espaco.
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
