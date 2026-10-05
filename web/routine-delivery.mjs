import { tagIdioma } from './locale.mjs';
// Janela de uma batida do scheduler (60s): protege só a entrega imediata da
// execução no MESMO canal, não lembretes futuros nem rotinas de ação (none).
export const ROUTINE_DELIVERY_WINDOW_MS = 60_000;
export const ROUTINE_NO_NEWS = '[ROTINA_SEM_NOVIDADES]';
const CHANNELS = { whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'e-mail' };
export function routineExecutionFrame({ kind, title = '', channel } = {}) {
  if (kind !== 'routine') return '';
  const base = `[EXECUÇÃO DE ROTINA] A rotina${title ? ` "${title}"` : ''} está disparando AGORA. O texto abaixo é a TAREFA que você deve executar neste instante, não um pedido pra agendar: a cadência (dias e horário) já está agendada pela plataforma e não depende de você. Execute a tarefa e devolva o RESULTADO pronto. Não descreva a rotina, não peça confirmação pra ativar, não diga que "já está configurada" e não altere a configuração dela. Se a tarefa não puder ser cumprida agora, diga o motivo concreto. Se cumprimentar, a saudação segue a hora local do "Contexto do sistema" no fim desta mensagem (bom dia até 12h, boa tarde até 18h, boa noite depois), nunca a de entregas anteriores desta conversa.`;
  const condition = `\n\n[ENTREGA CONDICIONAL] Só se a tarefa pedir explicitamente silêncio quando não houver novidades, e você tiver concluído a verificação com sucesso, responda EXATAMENTE ${ROUTINE_NO_NEWS} nesse caso, sem outra frase. A plataforma interpretará isso como não entregar mensagem. Não envie \"nenhuma novidade\". Nunca use esse sinal quando houver falha, busca parcial, acesso negado ou dúvida: informe a limitação. Não use silêncio para uma rotina que pede relatório mesmo sem novidades.`;
  if (!CHANNELS[channel]) return base + condition + '\n\n[ROTINA DE AÇÃO] Não há entrega automática neste modo. Só use ferramentas de envio se a tarefa pedir explicitamente; não envie recibos ou avisos extras. O resultado de uma ação não autoriza outra mensagem.';
  return base + condition + `\n\n[ENTREGA AUTOMÁTICA] A plataforma encaminhará sua resposta final diretamente ao usuário por ${CHANNELS[channel]}. Sua resposta É o conteúdo a entregar, não um recibo de envio. Se a tarefa diz "envie um lembrete", escreva o lembrete diretamente. Não diga "enviei", "enviado com sucesso" ou "vou enviar". Não crie rascunhos no Gmail/Outlook nem envie e-mails por ferramentas: a plataforma já entrega o resultado. Não chame enviar_mensagem nem criar_lembrete para repetir/adiar a própria entrega (nem para o próximo minuto); ela já é responsabilidade da plataforma. Lembretes FUTUROS independentes da entrega atual continuam permitidos, quando a tarefa realmente os pedir. Não é preciso recriar a recorrência: o agendador executará esta mesma rotina nos próximos dias/horários configurados.`;
}

// Rotina de texto livre (cardápio, sugestões, plano da semana) roda sempre na
// mesma thread e com o mesmo pedido. Sem aviso, o modelo lê as entregas
// anteriores no histórico e devolve a mesma coisa (caso de 02/10/2026: o
// mesmo cardápio de 5 pratos em três sextas seguidas). Curadoria, monitor de voos
// e busca de e-mail têm controle próprio e não passam por aqui. As entregas vão
// no frame, e não só no histórico, porque a compactação resume o histórico e os
// itens somem dele. Quem decide se a tarefa pede variedade continua sendo o
// modelo: lembrete fixo e relatório de dado novo repetem a estrutura de propósito.
const ENTREGAS_ANTERIORES = 3;
const ENTREGA_MAX_CHARS = 1500;
// Devolve o bloco já com a separação ('\n\n...') ou '' quando não se aplica.
export function routineVarietyBlock(history = [], { kind, ownControl = false } = {}) {
  if (kind !== 'routine' || ownControl) return '';
  const entregas = [];
  for (let i = history.length - 1; i >= 0 && entregas.length < ENTREGAS_ANTERIORES; i--) {
    const m = history[i];
    if (m?.role !== 'assistant' || typeof m.content !== 'string' || !m.content.trim()) continue;
    const t = m.content.trim();
    entregas.push(t.length > ENTREGA_MAX_CHARS ? t.slice(0, ENTREGA_MAX_CHARS) + ' [...]' : t);
  }
  if (!entregas.length) return '';
  return `\n\n[ENTREGAS ANTERIORES DESTA ROTINA] Abaixo está o que esta rotina entregou nas últimas ${entregas.length} execução(ões), da mais recente para a mais antiga. Se a tarefa pede conteúdo novo a cada execução (cardápio, receitas, sugestões, ideias, plano, lista de leitura), NÃO repita os itens já entregues: traga opções diferentes, a menos que a tarefa ou a pessoa tenha pedido para manter. Se a tarefa é um lembrete fixo ou um relatório de dados do dia (agenda, cotação, e-mails), repetir a estrutura é esperado; o que muda é o dado de hoje. Nunca copie uma entrega anterior como resposta.\n`
    + entregas.map((t, i) => `--- entrega ${i + 1} ---\n${t}`).join('\n');
}

export function routineReminderDeliveryConflict({ kind, channel, reminderChannel, whenMs, nowMs = Date.now() }) {
  if (kind !== 'routine' || !CHANNELS[channel] || reminderChannel !== channel || !Number.isFinite(whenMs)) return false;
  const delta = whenMs - nowMs;
  return delta >= -60_000 && delta <= ROUTINE_DELIVERY_WINDOW_MS;
}

export const ROUTINE_REMINDER_CONFLICT = 'NÃO criei outro lembrete: esta rotina já terá a resposta entregue automaticamente neste canal. Dentro do próximo minuto, devolva o texto do lembrete diretamente como resposta final, sem dizer que já enviou e sem tentar adiar a própria entrega. Esta trava não altera a recorrência da rotina. Lembretes futuros independentes, fora dessa janela, continuam disponíveis.';

// Protocolo de saída, não um detector semântico de novidades: a decisão sobre a
// condição da tarefa continua com o modelo. Só consome um sinal EXATO no contexto
// de rotina. Uma cobertura parcial conhecida impede o silêncio.
export function routineFinalText(text, { kind, completed = false, failed = false, language } = {}) {
  const s = String(text ?? '');
  if (kind !== 'routine' || s.trim() !== ROUTINE_NO_NEWS) return s;
  if (!completed || failed) return ({
    en: 'I could not confirm that there are no updates: this run has no successful check or encountered an error/limit.',
    es: 'No pude confirmar que no haya novedades: esta ejecución no tiene una comprobación exitosa o encontró un error/límite.',
  })[tagIdioma(language)] || 'Não pude confirmar que não há novidades: esta execução não tem uma verificação bem-sucedida ou encontrou erro/limite.';
  return ''; // O aviso obrigatório de cobertura é aplicado depois, inclusive aqui.
}
