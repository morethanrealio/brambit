// Listas pessoais: estado confirmado no banco, separado de eventos contáveis.
// Sem conexão/import de db aqui: o servidor injeta o pool e os testes usam SQL isolado.
import { randomUUID, createHash } from 'node:crypto';

export const CHECKLIST_SCHEMA = `
 CREATE TABLE IF NOT EXISTS mtr_harness.checklists (
   id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
   title text NOT NULL, name_key text NOT NULL, revision integer NOT NULL DEFAULT 0,
   items jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
   UNIQUE(user_id,name_key));
 CREATE TABLE IF NOT EXISTS mtr_harness.checklist_changes (
   list_id uuid NOT NULL REFERENCES mtr_harness.checklists(id) ON DELETE CASCADE,
   revision integer NOT NULL, request_key text NOT NULL, before_items jsonb NOT NULL,
   after_items jsonb NOT NULL, undo_of integer, created_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(list_id,revision), UNIQUE(list_id,request_key));
 ALTER TABLE mtr_harness.checklists ADD COLUMN IF NOT EXISTS finalizada_em timestamptz;
`;
const key = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const text = (value, label, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw Error(`${label} inválido.`);
  return value.trim();
};
const quantity = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e6) throw Error('Quantidade deve ser um número positivo até 1.000.000.');
  return value;
};
const unit = value => {
  const label=text(value,'Unidade',40);
  const aliases={un:'un',unidade:'un',unidades:'un',litro:'L',litros:'L',l:'L',quilo:'kg',quilos:'kg',quilograma:'kg',quilogramas:'kg',kg:'kg',grama:'g',gramas:'g',g:'g',ml:'ml',mililitro:'ml',mililitros:'ml'};
  return Object.hasOwn(aliases,key(label)) ? aliases[key(label)] : label;
};
const view = r => ({ id: r.id, nome: r.title, versao: r.revision, itens: r.items,
  pendentes: r.items.filter(i => !i.concluido).length, total: r.items.length,
  ...(r.finalizada_em ? { finalizada_em: new Date(r.finalizada_em).toISOString() } : {}) });
// Lista finalizada sai do nome (name_key ganha o id) e só é achada pelo id:
// assim "Supermercado" da próxima compra é uma lista nova, sem colidir.
const keyFinalizada = r => `${key(r.title)}#${r.id}`;
const error = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function createChecklistStore(pool) {
  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async function read(userId, name, db = pool, lock = false) {
    const { rows } = await db.query(`SELECT * FROM mtr_harness.checklists WHERE user_id=$1 AND (id::text=$2 OR name_key=$3)${lock ? ' FOR UPDATE' : ''}`, [userId, String(name), key(name)]);
    return rows[0]; // Correspondência exata; nunca selecionar por substring.
  }
  return {
    init: () => pool.query(CHECKLIST_SCHEMA),
    async list(userId, name) {
      if (name) { const r = await read(userId, name); return r ? { ok: true, lista: view(r) } : error('NOT_FOUND', 'Lista não encontrada. Consulte as listas existentes; não conclua que uma lista antiga está vazia.'); }
      const { rows } = await pool.query('SELECT * FROM mtr_harness.checklists WHERE user_id=$1 AND finalizada_em IS NULL ORDER BY updated_at DESC LIMIT 101', [userId]);
      const fin = await pool.query('SELECT * FROM mtr_harness.checklists WHERE user_id=$1 AND finalizada_em IS NOT NULL ORDER BY finalizada_em DESC LIMIT 5', [userId]);
      const resumo = r => { const { itens, ...v } = view(r); return v; };
      return { ok: true, listas: rows.slice(0,100).map(resumo), parcial: rows.length > 100,
        ...(fin.rows.length ? { finalizadas_recentes: fin.rows.map(resumo) } : {}) };
    },
    async create(userId, name) {
      const title = text(name, 'Nome da lista');
      const { rows } = await pool.query(`INSERT INTO mtr_harness.checklists(id,user_id,title,name_key)
        VALUES($1,$2,$3,$4) ON CONFLICT(user_id,name_key) DO NOTHING RETURNING *`, [randomUUID(), userId, title, key(title)]);
      return { ok: true, criada: !!rows.length, lista: view(rows[0] || await read(userId, title)) };
    },
    async edit(userId, { lista, versao, operacoes, acao = 'itens', requestKey }) {
      if (!Number.isSafeInteger(versao) || versao < 0) return error('VERSION_REQUIRED', 'Consulte a lista antes de alterar.');
      if (!['itens','zerar','desfazer','finalizar','reabrir'].includes(acao)) return error('INVALID_ACTION', 'Ação de lista inválida.');
      text(requestKey, 'Identidade do pedido', 128);
      if (acao === 'itens' && (!Array.isArray(operacoes) || !operacoes.length || operacoes.length > 100)) return error('INVALID_OPERATIONS', 'Envie de 1 a 100 alterações de itens.');
      if (acao !== 'itens' && operacoes?.length) return error('INVALID_OPERATIONS', 'Zerar/desfazer/finalizar/reabrir não pode incluir outras alterações.');
      return transaction(async c => {
        const r = await read(userId, lista, c, true);
        if (!r) return error('NOT_FOUND', 'Lista não encontrada para esta conta.');
        const previous = await c.query('SELECT revision FROM mtr_harness.checklist_changes WHERE list_id=$1 AND request_key=$2', [r.id, requestKey]);
        if (previous.rows.length) return { ok: true, repetido: true, lista: view(r) };
        if (r.revision !== versao) return error('CONFLICT', 'A lista mudou. Leia o estado atual e preserve as alterações antes de continuar.', { lista: view(r) });
        if (acao === 'reabrir') {
          if (!r.finalizada_em) return { ok: true, sem_alteracao: true, lista: view(r) };
          const ativa = await read(userId, r.title, c);
          if (ativa) return error('NAME_IN_USE', 'Já existe uma lista ativa com esse nome. Pergunte se os itens vão para ela; não reabra a antiga por conta própria.', { lista_ativa: view(ativa) });
        } else if (r.finalizada_em && acao !== 'finalizar') {
          return error('LIST_FINALIZED', 'Esta lista foi finalizada. Itens novos vão numa lista nova (criar_lista, pode ser o mesmo nome); só reabra se a pessoa pedir para continuar esta.', { lista: view(r) });
        }
        if (acao === 'finalizar' || acao === 'reabrir') {
          if (acao === 'finalizar' && r.finalizada_em) return { ok: true, sem_alteracao: true, lista: view(r) };
          const revision = r.revision + 1;
          await c.query(`INSERT INTO mtr_harness.checklist_changes(list_id,revision,request_key,before_items,after_items,undo_of) VALUES($1,$2,$3,$4::jsonb,$4::jsonb,NULL)`, [r.id,revision,requestKey,JSON.stringify(r.items)]);
          const fecha = acao === 'finalizar';
          const { rows } = await c.query(`UPDATE mtr_harness.checklists SET finalizada_em=${fecha ? 'now()' : 'NULL'},name_key=$3,revision=$4,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
            [r.id,userId,fecha ? keyFinalizada(r) : key(r.title),revision]);
          return { ok: true, lista: view(rows[0]), [fecha ? 'finalizada' : 'reaberta']: true };
        }
        let items = structuredClone(r.items);
        let undoOf = null;
        if (acao === 'zerar') items = [];
        else if (acao === 'desfazer') {
          const last = await c.query(`SELECT h.before_items,h.revision FROM mtr_harness.checklist_changes h WHERE h.list_id=$1 AND h.undo_of IS NULL
            AND NOT EXISTS(SELECT 1 FROM mtr_harness.checklist_changes u WHERE u.list_id=h.list_id AND u.undo_of=h.revision)
            ORDER BY h.revision DESC LIMIT 1`, [r.id]);
          if (!last.rows.length) return error('NO_CHANGE', 'Não há alteração para desfazer nesta lista.');
          items = last.rows[0].before_items;
          undoOf = last.rows[0].revision;
        } else for (const op of operacoes) {
          if (!op || typeof op !== 'object' || !['adicionar','atualizar','remover'].includes(op.tipo)) throw Error('Operação de item inválida. Nada foi alterado.');
          if (op.tipo === 'adicionar') {
            const nome = text(op.nome, 'Nome do item'), unidade = op.unidade === undefined ? 'un' : unit(op.unidade);
            const quantidade = op.quantidade === undefined ? 1 : quantity(op.quantidade);
            // Repetir um item significa manter a quantidade; nunca somar implicitamente.
            const exists = items.find(i => key(i.nome) === key(nome) && key(i.unidade) === key(unidade));
            if (exists) {
              if (exists.quantidade !== quantidade || exists.concluido) throw Error(`O item "${nome}" já existe. Use atualizar com seu id e a quantidade TOTAL desejada; não some nem reabra sem o pedido da pessoa.`);
            } else items.push({ id: randomUUID(), nome, quantidade, unidade, concluido: false });
          } else {
            const item = items.find(i => i.id === op.id);
            if (!item) throw Error('Item não encontrado nesta lista. Consulte o estado atual antes de alterar.');
            if (op.tipo === 'remover') items = items.filter(i => i.id !== op.id);
            else {
              if (op.nome !== undefined) item.nome = text(op.nome, 'Nome do item');
              if (op.quantidade !== undefined) item.quantidade = quantity(op.quantidade);
              if (op.unidade !== undefined) item.unidade = unit(op.unidade);
              if (op.concluido !== undefined) {
                if (typeof op.concluido !== 'boolean') throw Error('Estado do item inválido.');
                item.concluido = op.concluido;
              }
            }
          }
        }
        if (items.length > 500) throw Error('Esta lista atingiu o limite de 500 itens. Nada foi alterado.');
        if (new Set(items.map(i => JSON.stringify([key(i.nome),key(i.unidade)]))).size !== items.length) throw Error('A alteração duplicaria um item da mesma unidade. Nada foi alterado.');
        if (JSON.stringify(items) === JSON.stringify(r.items)) return { ok: true, sem_alteracao: true, lista: view(r) };
        const revision = r.revision + 1;
        await c.query(`INSERT INTO mtr_harness.checklist_changes(list_id,revision,request_key,before_items,after_items,undo_of) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`, [r.id,revision,requestKey,JSON.stringify(r.items),JSON.stringify(items),undoOf]);
        const { rows } = await c.query('UPDATE mtr_harness.checklists SET items=$3::jsonb,revision=$4,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [r.id,userId,JSON.stringify(items),revision]);
        return { ok: true, lista: view(rows[0]), recuperavel: true };
      });
    },
  };
}

export const CHECKLIST_CONTEXT = `LISTAS PESSOAIS: para compras/checklists simples, use consultar_listas/criar_lista/editar_lista. Quando a pessoa encerrar a lista ("finalizar", "fechar a lista", "terminei a lista"), chame editar_lista com acao="finalizar" antes de mostrar a lista final. Lista finalizada fica guardada, mas não recebe itens: se depois a pessoa mandar itens para "a lista de compras" sem dizer que é a antiga, é uma compra nova, então crie outra lista (pode ser o mesmo nome). Só reabra (acao="reabrir") se ela pedir para continuar a antiga. Consulte o banco antes de afirmar conteúdo, vazio ou alteração; memória da conversa não é o estado atual. Se a lista já mora em app, planilha, espaço ou memória, leia essa fonte e continue nela; não inicie uma cópia vazia nem migre silenciosamente. Dois alvos possíveis: pergunte qual. Preserve quantidades e unidades; "peguei/já tenho" dá baixa, "faltam dois" define quantidade pendente conforme o contexto. Não some unidades diferentes. Só diga que salvou após ok:true. Responda brevemente com a mudança; não despeje todos os itens a cada compra. Ids e versões são internos. Nunca peça ao usuário para escolher uma tecnologia de armazenamento.`;

export function checklistTools({ store, userId, requestId, findExisting = async () => null }) {
  const wrap = fn => async args => {
    try { return JSON.stringify(await fn(args || {})); }
    catch (e) { return JSON.stringify(error('NOT_SAVED', e.message)); }
  };
  return [
    { name: 'consultar_listas', description: 'Consulta as listas pessoais e seu estado persistente. Sem lista, traz nomes/ids; com nome EXATO ou id, traz itens, quantidades e versão atual. Lista não encontrada não significa lista vazia: confira a fonte antiga indicada na memória antes de criar outra. Listas finalizadas aparecem à parte (finalizadas_recentes) e só recebem itens se reabertas a pedido.',
      parameters: { type: 'object', properties: { lista: { type: 'string' } } }, run: wrap(({ lista }) => store.list(userId, lista)) },
    { name: 'criar_lista', description: 'Cria uma lista pessoal simples, apenas quando solicitada e não houver fonte existente. Para lista que já existe em app/planilha/memória, continue na fonte original. Nunca cria app nem apaga itens de lista existente. Lista finalizada não conta como existente: a compra seguinte ganha lista nova, mesmo com o mesmo nome.',
      parameters: { type: 'object', properties: { nome: { type: 'string' } }, required: ['nome'] },
      run: wrap(async ({ nome }) => {
        text(nome, 'Nome da lista');
        const existing = await store.list(userId, nome);
        if (existing.ok) return existing;
        const collision = await findExisting(nome);
        if (collision) return error('EXISTING_SOURCE', 'Há uma fonte existente. Consulte-a antes de criar uma lista separada.', { fonte: collision });
        return store.create(userId, nome);
      }) },
    { name: 'editar_lista', description: 'Altera atomicamente UMA lista lida em consultar_listas. Passe id/nome exato, versão e alterações. Adicionar não soma nem duplica item já existente. Atualizar usa id do item e quantidade TOTAL (não incremento); concluido=true dá baixa e false reabre. Para compra parcial, ajuste a quantidade restante. Zerar afeta só a lista explicitamente escolhida; desfazer recupera sua última alteração. Finalizar encerra a lista quando a pessoa diz que terminou (ela sai das listas ativas e o nome fica livre para a próxima); reabrir só a pedido. Nunca adivinhe o alvo, nunca confirme sucesso sem ok:true.',
      parameters: { type: 'object', additionalProperties: false, required: ['lista','versao','acao'], properties: {
        lista: { type: 'string' }, versao: { type: 'integer', minimum: 0 }, acao: { type: 'string', enum: ['itens','zerar','desfazer','finalizar','reabrir'] },
        operacoes: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['tipo'], properties: {
          tipo: { type: 'string', enum: ['adicionar','atualizar','remover'] }, id: { type: 'string' }, nome: { type: 'string' }, quantidade: { type: 'number', exclusiveMinimum: 0 }, unidade: { type: 'string' }, concluido: { type: 'boolean' },
        } } },
      } }, run: wrap(args => store.edit(userId, { ...args, requestKey: createHash('sha256').update(JSON.stringify([requestId,args])).digest('hex') })) },
  ];
}
