// Frases do cartão para as tools que entraram no portão em 28/09 (auditoria das
// ~41 ferramentas que gravavam/enviavam só por decisão do modelo). Cada entrada:
// [pedido(args), feito(args)] por idioma. O confirm.mjs usa o pt-BR; o
// confirm-textos.mjs usa en/es. Ficam num arquivo só pra nenhuma tool nova do
// portão aparecer com o genérico "executar a ação x".
const q = (v, d = '') => String(v ?? d);

export const PORTAO_TEXTOS = {
  falar_com_agente: {
    'pt-BR': [a => `falar com o assistente de ${q(a.contato, 'o contato')} em seu nome sobre: ${q(a.objetivo, '(sem objetivo)')}`, a => `Conversei com o assistente de ${q(a.contato, 'o contato')}.`],
    en: [a => `talk to ${q(a.contato, 'the contact')}'s assistant on your behalf about: ${q(a.objetivo, '(no goal)')}`, a => `I talked to ${q(a.contato, 'the contact')}'s assistant.`],
    es: [a => `hablar con el asistente de ${q(a.contato, 'el contacto')} en tu nombre sobre: ${q(a.objetivo, '(sin objetivo)')}`, a => `Hablé con el asistente de ${q(a.contato, 'el contacto')}.`],
  },
  responder_pergunta_externa: {
    'pt-BR': [a => `mandar esta resposta ao assistente de ${q(a.para, 'o contato')}: "${q(a.resposta)}"`, a => `Resposta enviada ao assistente de ${q(a.para, 'o contato')}.`],
    en: [a => `send this answer to ${q(a.para, 'the contact')}'s assistant: "${q(a.resposta)}"`, a => `Answer sent to ${q(a.para, 'the contact')}'s assistant.`],
    es: [a => `enviar esta respuesta al asistente de ${q(a.para, 'el contacto')}: "${q(a.resposta)}"`, a => `Respuesta enviada al asistente de ${q(a.para, 'el contacto')}.`],
  },
  aceitar_contato: {
    'pt-BR': [a => `aceitar o pedido de conexão de ${q(a.de, 'o contato')} (o assistente dele passa a poder falar com o seu)`, a => `Conexão com ${q(a.de, 'o contato')} aceita.`],
    en: [a => `accept the connection request from ${q(a.de, 'the contact')} (their assistant will be able to talk to yours)`, a => `Connection with ${q(a.de, 'the contact')} accepted.`],
    es: [a => `aceptar la solicitud de conexión de ${q(a.de, 'el contacto')} (su asistente podrá hablar con el tuyo)`, a => `Conexión con ${q(a.de, 'el contacto')} aceptada.`],
  },
  recusar_contato: {
    'pt-BR': [a => `recusar o pedido de conexão de ${q(a.de || a.email, 'o contato')}`, a => `Pedido de ${q(a.de || a.email, 'o contato')} recusado.`],
    en: [a => `decline the connection request from ${q(a.de || a.email, 'the contact')}`, a => `Request from ${q(a.de || a.email, 'the contact')} declined.`],
    es: [a => `rechazar la solicitud de conexión de ${q(a.de || a.email, 'el contacto')}`, a => `Solicitud de ${q(a.de || a.email, 'el contacto')} rechazada.`],
  },
  convidar_contato: {
    'pt-BR': [a => `mandar convite de conexão (com e-mail) para ${q(a.email, '(sem e-mail)')}`, a => `Convite enviado para ${q(a.email)}.`],
    en: [a => `send a connection invite (by email) to ${q(a.email, '(no email)')}`, a => `Invite sent to ${q(a.email)}.`],
    es: [a => `enviar una invitación de conexión (por correo) a ${q(a.email, '(sin correo)')}`, a => `Invitación enviada a ${q(a.email)}.`],
  },
  anotar_no_espaco: {
    'pt-BR': [a => `anotar no Space "${q(a.espaco)}" (todos os participantes veem): "${q(a.nota)}"`, a => `Anotado no Space "${q(a.espaco)}".`],
    en: [a => `add a note to the Space "${q(a.espaco)}" (every member sees it): "${q(a.nota)}"`, a => `Note added to the Space "${q(a.espaco)}".`],
    es: [a => `anotar en el Space "${q(a.espaco)}" (todos los participantes lo ven): "${q(a.nota)}"`, a => `Anotado en el Space "${q(a.espaco)}".`],
  },
  configurar_espaco: {
    'pt-BR': [a => `mudar a configuração do Space "${q(a.espaco)}"${a.modo ? ` para o modo "${a.modo}"` : ''}`, a => `Space "${q(a.espaco)}" atualizado.`],
    en: [a => `change the settings of the Space "${q(a.espaco)}"${a.modo ? ` to mode "${a.modo}"` : ''}`, a => `Space "${q(a.espaco)}" updated.`],
    es: [a => `cambiar la configuración del Space "${q(a.espaco)}"${a.modo ? ` al modo "${a.modo}"` : ''}`, a => `Space "${q(a.espaco)}" actualizado.`],
  },
  editar_nota: {
    'pt-BR': [a => `trocar a nota ${q(a.nota_id, '(?)')} do Space "${q(a.espaco)}" por: "${q(a.nova_nota)}"`, a => `Nota do Space "${q(a.espaco)}" editada.`],
    en: [a => `replace note ${q(a.nota_id, '(?)')} in the Space "${q(a.espaco)}" with: "${q(a.nova_nota)}"`, a => `Note in the Space "${q(a.espaco)}" edited.`],
    es: [a => `reemplazar la nota ${q(a.nota_id, '(?)')} del Space "${q(a.espaco)}" por: "${q(a.nova_nota)}"`, a => `Nota del Space "${q(a.espaco)}" editada.`],
  },
  apagar_nota: {
    'pt-BR': [a => `apagar a nota ${q(a.nota_id, '(?)')} do Space "${q(a.espaco)}" para todos os participantes`, a => `Nota apagada do Space "${q(a.espaco)}".`],
    en: [a => `delete note ${q(a.nota_id, '(?)')} from the Space "${q(a.espaco)}" for every member`, a => `Note deleted from the Space "${q(a.espaco)}".`],
    es: [a => `borrar la nota ${q(a.nota_id, '(?)')} del Space "${q(a.espaco)}" para todos los participantes`, a => `Nota borrada del Space "${q(a.espaco)}".`],
  },
  sair_do_espaco: {
    'pt-BR': [a => `sair do Space "${q(a.espaco)}" (você deixa de ver as notas dele)`, a => `Você saiu do Space "${q(a.espaco)}".`],
    en: [a => `leave the Space "${q(a.espaco)}" (you stop seeing its notes)`, a => `You left the Space "${q(a.espaco)}".`],
    es: [a => `salir del Space "${q(a.espaco)}" (dejas de ver sus notas)`, a => `Saliste del Space "${q(a.espaco)}".`],
  },
  remover_do_espaco: {
    'pt-BR': [a => `tirar ${q(a.contato, 'o contato')} do Space "${q(a.espaco)}"`, a => `${q(a.contato, 'O contato')} saiu do Space "${q(a.espaco)}".`],
    en: [a => `remove ${q(a.contato, 'the contact')} from the Space "${q(a.espaco)}"`, a => `${q(a.contato, 'The contact')} was removed from the Space "${q(a.espaco)}".`],
    es: [a => `quitar a ${q(a.contato, 'el contacto')} del Space "${q(a.espaco)}"`, a => `${q(a.contato, 'El contacto')} salió del Space "${q(a.espaco)}".`],
  },
  editar_skill: {
    'pt-BR': [a => `alterar a Skill "${q(a.skill)}"${a.script ? ' (inclusive o script)' : ''}`, a => `Skill "${q(a.nome || a.skill)}" atualizada.`],
    en: [a => `change the Skill "${q(a.skill)}"${a.script ? ' (including its script)' : ''}`, a => `Skill "${q(a.nome || a.skill)}" updated.`],
    es: [a => `cambiar la Skill "${q(a.skill)}"${a.script ? ' (incluido el script)' : ''}`, a => `Skill "${q(a.nome || a.skill)}" actualizada.`],
  },
  apagar_skill: {
    'pt-BR': [a => `apagar de vez a Skill "${q(a.skill)}"`, a => `Skill "${q(a.skill)}" apagada.`],
    en: [a => `permanently delete the Skill "${q(a.skill)}"`, a => `Skill "${q(a.skill)}" deleted.`],
    es: [a => `borrar definitivamente la Skill "${q(a.skill)}"`, a => `Skill "${q(a.skill)}" borrada.`],
  },
  desinstalar_skill: {
    'pt-BR': [a => `desinstalar a Skill "${q(a.skill)}"${a.de ? ` de ${a.de}` : ''} deste assistente`, a => `Skill "${q(a.skill)}" desinstalada.`],
    en: [a => `uninstall the Skill "${q(a.skill)}"${a.de ? ` from ${a.de}` : ''} from this assistant`, a => `Skill "${q(a.skill)}" uninstalled.`],
    es: [a => `desinstalar la Skill "${q(a.skill)}"${a.de ? ` de ${a.de}` : ''} de este asistente`, a => `Skill "${q(a.skill)}" desinstalada.`],
  },
  remover_colaborador: {
    'pt-BR': [a => `tirar ${q(a.contato, 'o contato')} da colaboração no sistema "${q(a.nome_do_sistema)}"`, a => `${q(a.contato, 'O contato')} não colabora mais no sistema "${q(a.nome_do_sistema)}".`],
    en: [a => `remove ${q(a.contato, 'the contact')} as a collaborator on the system "${q(a.nome_do_sistema)}"`, a => `${q(a.contato, 'The contact')} no longer collaborates on "${q(a.nome_do_sistema)}".`],
    es: [a => `quitar a ${q(a.contato, 'el contacto')} como colaborador del sistema "${q(a.nome_do_sistema)}"`, a => `${q(a.contato, 'El contacto')} ya no colabora en "${q(a.nome_do_sistema)}".`],
  },
  definir_visibilidade_sistema: {
    'pt-BR': [a => `deixar o sistema "${q(a.nome_do_sistema)}" com visibilidade "${q(a.visibilidade, '(?)')}"`, a => `Visibilidade do sistema "${q(a.nome_do_sistema)}" agora é "${q(a.visibilidade)}".`],
    en: [a => `set the system "${q(a.nome_do_sistema)}" visibility to "${q(a.visibilidade, '(?)')}"`, a => `System "${q(a.nome_do_sistema)}" visibility is now "${q(a.visibilidade)}".`],
    es: [a => `poner la visibilidad del sistema "${q(a.nome_do_sistema)}" en "${q(a.visibilidade, '(?)')}"`, a => `La visibilidad del sistema "${q(a.nome_do_sistema)}" ahora es "${q(a.visibilidade)}".`],
  },
  definir_acesso_sistema: {
    'pt-BR': [a => a.acesso === 'publico' ? `deixar o sistema "${q(a.nome_do_sistema)}" ABERTO: qualquer pessoa com o link entra, sem senha` : `trancar o sistema "${q(a.nome_do_sistema)}" com login e senha${a.nova_senha ? ' (gerando senha nova)' : ''}`, a => a.acesso === 'publico' ? `Sistema "${q(a.nome_do_sistema)}" agora é aberto.` : `Sistema "${q(a.nome_do_sistema)}" trancado com senha.`],
    en: [a => a.acesso === 'publico' ? `make the system "${q(a.nome_do_sistema)}" OPEN: anyone with the link gets in, no password` : `lock the system "${q(a.nome_do_sistema)}" with a login and password${a.nova_senha ? ' (new password)' : ''}`, a => a.acesso === 'publico' ? `System "${q(a.nome_do_sistema)}" is now open.` : `System "${q(a.nome_do_sistema)}" locked with a password.`],
    es: [a => a.acesso === 'publico' ? `dejar el sistema "${q(a.nome_do_sistema)}" ABIERTO: cualquiera con el enlace entra, sin contraseña` : `cerrar el sistema "${q(a.nome_do_sistema)}" con usuario y contraseña${a.nova_senha ? ' (contraseña nueva)' : ''}`, a => a.acesso === 'publico' ? `El sistema "${q(a.nome_do_sistema)}" ahora está abierto.` : `Sistema "${q(a.nome_do_sistema)}" cerrado con contraseña.`],
  },
  remover_da_home: {
    'pt-BR': [a => `tirar o bloco ${q(a.id, '(?)')} da página inicial do seu subdomínio`, a => `Bloco ${q(a.id)} tirado da página inicial.`],
    en: [a => `remove block ${q(a.id, '(?)')} from your subdomain home page`, a => `Block ${q(a.id)} removed from the home page.`],
    es: [a => `quitar el bloque ${q(a.id, '(?)')} de la página de inicio de tu subdominio`, a => `Bloque ${q(a.id)} quitado de la página de inicio.`],
  },
  parar_sistema: {
    'pt-BR': [a => `parar o sistema "${q(a.nome_do_sistema)}" (sai do ar até ser reiniciado; os dados ficam)`, a => `Sistema "${q(a.nome_do_sistema)}" parado.`],
    en: [a => `stop the system "${q(a.nome_do_sistema)}" (offline until restarted; data is kept)`, a => `System "${q(a.nome_do_sistema)}" stopped.`],
    es: [a => `detener el sistema "${q(a.nome_do_sistema)}" (queda fuera de línea hasta reiniciarlo; los datos se conservan)`, a => `Sistema "${q(a.nome_do_sistema)}" detenido.`],
  },
  reiniciar_sistema: {
    'pt-BR': [a => `reiniciar o sistema "${q(a.nome_do_sistema)}" (fica fora do ar por alguns segundos)`, a => `Sistema "${q(a.nome_do_sistema)}" reiniciado.`],
    en: [a => `restart the system "${q(a.nome_do_sistema)}" (offline for a few seconds)`, a => `System "${q(a.nome_do_sistema)}" restarted.`],
    es: [a => `reiniciar el sistema "${q(a.nome_do_sistema)}" (queda fuera de línea unos segundos)`, a => `Sistema "${q(a.nome_do_sistema)}" reiniciado.`],
  },
  enviar_midia_para_sistema: {
    'pt-BR': [a => `enviar a mídia ${q(a.id_midia, '(?)')} para ${q(a.metodo, 'POST')} ${q(a.rota, '(?)')} do sistema "${q(a.nome_do_sistema)}" (grava no app)`, a => `Mídia enviada ao sistema "${q(a.nome_do_sistema)}".`],
    en: [a => `send media ${q(a.id_midia, '(?)')} to ${q(a.metodo, 'POST')} ${q(a.rota, '(?)')} on the system "${q(a.nome_do_sistema)}" (writes to the app)`, a => `Media sent to the system "${q(a.nome_do_sistema)}".`],
    es: [a => `enviar el archivo ${q(a.id_midia, '(?)')} a ${q(a.metodo, 'POST')} ${q(a.rota, '(?)')} del sistema "${q(a.nome_do_sistema)}" (graba en la app)`, a => `Archivo enviado al sistema "${q(a.nome_do_sistema)}".`],
  },
  gmail_label_create: {
    'pt-BR': [a => `criar o marcador "${q(a.nome)}" no seu Gmail`, a => `Marcador "${q(a.nome)}" criado no Gmail.`],
    en: [a => `create the label "${q(a.nome)}" in your Gmail`, a => `Label "${q(a.nome)}" created in Gmail.`],
    es: [a => `crear la etiqueta "${q(a.nome)}" en tu Gmail`, a => `Etiqueta "${q(a.nome)}" creada en Gmail.`],
  },
  gmail_label_update: {
    'pt-BR': [a => `renomear o marcador "${q(a.marcador)}" do Gmail para "${q(a.novo_nome)}"`, a => `Marcador renomeado para "${q(a.novo_nome)}".`],
    en: [a => `rename the Gmail label "${q(a.marcador)}" to "${q(a.novo_nome)}"`, a => `Label renamed to "${q(a.novo_nome)}".`],
    es: [a => `renombrar la etiqueta de Gmail "${q(a.marcador)}" a "${q(a.novo_nome)}"`, a => `Etiqueta renombrada a "${q(a.novo_nome)}".`],
  },
  configurar_deploy: {
    'pt-BR': [a => `configurar o deploy do projeto${a.host ? ` para ${a.usuario ? `${a.usuario}@` : ''}${a.host}` : ''}${a.comando ? ` rodando "${a.comando}"` : ''}`, () => 'Deploy do projeto configurado.'],
    en: [a => `set up the project deploy${a.host ? ` to ${a.usuario ? `${a.usuario}@` : ''}${a.host}` : ''}${a.comando ? ` running "${a.comando}"` : ''}`, () => 'Project deploy configured.'],
    es: [a => `configurar el deploy del proyecto${a.host ? ` a ${a.usuario ? `${a.usuario}@` : ''}${a.host}` : ''}${a.comando ? ` ejecutando "${a.comando}"` : ''}`, () => 'Deploy del proyecto configurado.'],
  },
  cancelar_rotina: {
    'pt-BR': [a => `cancelar de vez a rotina ${a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${q(a.titulo)}"`}`, a => `Rotina ${a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${q(a.titulo)}"`} cancelada.`],
    en: [a => `permanently cancel the routine ${a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${q(a.titulo)}"`}`, a => `Routine ${a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${q(a.titulo)}"`} cancelled.`],
    es: [a => `cancelar definitivamente la rutina ${a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${q(a.titulo)}"`}`, a => `Rutina ${a.id ? `#${String(a.id).replace(/^#/, '')}` : `"${q(a.titulo)}"`} cancelada.`],
  },
  remover_evento: {
    'pt-BR': [a => `apagar o registro de ${q(a.data, '(data?)')} do tracker "${q(a.tracker)}"`, a => `Registro apagado do tracker "${q(a.tracker)}".`],
    en: [a => `delete the ${q(a.data, '(date?)')} entry from the tracker "${q(a.tracker)}"`, a => `Entry deleted from the tracker "${q(a.tracker)}".`],
    es: [a => `borrar el registro del ${q(a.data, '(¿fecha?)')} del tracker "${q(a.tracker)}"`, a => `Registro borrado del tracker "${q(a.tracker)}".`],
  },
  remover_tracker: {
    'pt-BR': [a => `apagar o tracker "${q(a.tracker)}" com todos os registros`, a => `Tracker "${q(a.tracker)}" apagado.`],
    en: [a => `delete the tracker "${q(a.tracker)}" and all its entries`, a => `Tracker "${q(a.tracker)}" deleted.`],
    es: [a => `borrar el tracker "${q(a.tracker)}" con todos sus registros`, a => `Tracker "${q(a.tracker)}" borrado.`],
  },
  remover_monitor: {
    'pt-BR': [a => `parar de monitorar "${q(a.monitor)}" (o histórico fica guardado)`, a => `Parei de monitorar "${q(a.monitor)}".`],
    en: [a => `stop monitoring "${q(a.monitor)}" (history is kept)`, a => `Stopped monitoring "${q(a.monitor)}".`],
    es: [a => `dejar de monitorear "${q(a.monitor)}" (el historial se conserva)`, a => `Dejé de monitorear "${q(a.monitor)}".`],
  },
  definir_modo_permissao: {
    'pt-BR': [a => `mudar o modo de permissão para "${q(a.modo, '(?)')}"${a.modo === 'aceitar_edicoes' ? ': edições de código passam a rodar sem pedir confirmação' : ''}`, a => `Modo de permissão agora é "${q(a.modo)}" (vale a partir da próxima mensagem).`],
    en: [a => `change the permission mode to "${q(a.modo, '(?)')}"${a.modo === 'aceitar_edicoes' ? ': code edits will run without asking for confirmation' : ''}`, a => `Permission mode is now "${q(a.modo)}" (from the next message on).`],
    es: [a => `cambiar el modo de permiso a "${q(a.modo, '(?)')}"${a.modo === 'aceitar_edicoes' ? ': las ediciones de código se ejecutarán sin pedir confirmación' : ''}`, a => `El modo de permiso ahora es "${q(a.modo)}" (desde el próximo mensaje).`],
  },
  permitir_comando: {
    'pt-BR': [a => `liberar para sempre os comandos que começam com "${q(a.prefixo, '(?)')}" (passam a rodar sem pedir confirmação)`, a => `Comandos "${q(a.prefixo)}" liberados.`],
    en: [a => `permanently allow commands starting with "${q(a.prefixo, '(?)')}" (they will run without asking)`, a => `Commands "${q(a.prefixo)}" allowed.`],
    es: [a => `permitir para siempre los comandos que empiezan con "${q(a.prefixo, '(?)')}" (se ejecutarán sin preguntar)`, a => `Comandos "${q(a.prefixo)}" permitidos.`],
  },
};

// Apagam de vez, saem para terceiros ou tiram o app do ar: joinha não basta.
export const PORTAO_IRREVERSIVEIS = [
  'falar_com_agente', 'responder_pergunta_externa', 'convidar_contato',
  'apagar_nota', 'remover_do_espaco', 'apagar_skill',
  'remover_tracker', 'cancelar_rotina', 'permitir_comando',
];

export function portaoTexto(lang, name, args = {}, which = 0) {
  const f = PORTAO_TEXTOS[name]?.[lang]?.[which];
  if (!f) return null;
  try { return f(args || {}); } catch { return null; }
}
