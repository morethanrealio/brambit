// A test requested while an edit awaits approval must not run the old config.
export function pendingRoutineEdit(rows, routine) {
  return rows.some(row=>row.state==='pending'&&row.name==='editar_rotina'&&(
    row.args?.id===routine.id || (!row.args?.id&&row.args?.titulo&&String(routine.title).toLowerCase().includes(String(row.args.titulo).toLowerCase()))));
}
export function routineTestOutcome(result) {
  const content=result?.contentStatus;
  const delivery=result?.delivery?.status;
  const generation=content==='complete'?'O teste da versão atualizada gerou o conteúdo.'
    :content==='partial'?'O teste da versão atualizada gerou conteúdo parcial; confira as limitações no resultado.'
    :content==='no_output'?'O teste não gerou conteúdo para entregar.'
    :content==='failed'?'O teste falhou ao gerar o conteúdo.'
    :'Não consegui confirmar o resultado do teste.';
  const destination=delivery==='accepted'?'O serviço aceitou o envio no canal configurado.'
    :delivery==='saved'?'O resultado ficou salvo no app.'
    :delivery==='not_attempted'||content==='no_output'?'Nenhum envio foi feito.'
    :'A entrega não foi confirmada; confira o canal antes de repetir o teste.';
  return `${generation} ${destination}`;
}
