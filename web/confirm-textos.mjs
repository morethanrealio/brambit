import { configurationLabel, completionLabel, retryLabel } from './discovery-conversation.mjs';
// Textos do PORTÃO DE CONFIRMAÇÃO em inglês e espanhol.
//
// Por que um arquivo separado, e não uma tabela de mensagens substituindo o
// português do confirm.mjs: o texto de confirmação é o único lugar do produto
// onde a frase que o usuário lê é escrita por CÓDIGO, não pelo modelo. Ela é o
// que ele aprova ("posso enviar?") e o que ele recebe depois ("✅ E-mail
// enviado"). Reescrever o caminho do pt-BR pra encaixar num catálogo de i18n
// mexeria em ~110 frases que hoje estão certas e em produção, sem ganho nenhum
// pra quem fala português: qualquer erro de digitação ali seria uma regressão
// nova num texto que já funciona. Então o pt-BR do confirm.mjs fica INTACTO,
// byte a byte, e en/es entram como tabelas paralelas que só são consultadas
// quando o idioma do usuário não é o padrão.
//
// O que isto NÃO cobre, de propósito:
//  • `descreverCarrinho` (compras.mjs) devolve o resumo do carrinho em
//    português. Traduzir aquilo é mexer no subsistema de compras, que tem
//    lógica própria de preço/frete; ficou fora desta fase e está declarado
//    abaixo no lugar onde aparece.
//  • `routineDaysLabel`/`intervalLabel` (scheduler.mjs) também são em
//    português e são usados na LISTA de rotinas, não só aqui. Em vez de
//    traduzir lá e arrastar a tela de rotinas junto, a cadência do cartão é
//    montada aqui, a partir do mesmo `parseRoutineDays` que a tool usa pra
//    gravar. Assim o cartão não pode descrever um dia diferente do que vai ser
//    salvo, que era o motivo de existir aquele reaproveitamento.
import { normalizeRoutineDays, parseRoutineDays } from './scheduler.mjs';
import { routineArgsTimeLabel } from './routine-time.mjs';
import { descreverCarrinho, plataformaDoCarrinho } from './compras.mjs';
import { portaoTexto } from './confirm-textos-portao.mjs';
import { marca } from './marca.mjs';

// O cc sai no envio de verdade mas não aparecia no cartão de confirmação: a pessoa
// autorizava "mandar pra X" sem saber que uma cópia também ia pra Y. Como
// gmail_send/hotmail_send são irreversíveis, esse cartão é a única barreira antes
// do envio, então ele tem que descrever a ação inteira.
export function copiaLabel(cc, lang = 'pt') {
  const v = String(cc == null ? '' : cc).trim();
  if (!v) return '';
  if (lang === 'en') return ` (with a copy to ${v})`;
  if (lang === 'es') return ` (con copia a ${v})`;
  return ` (com cópia para ${v})`;
}

// Campos de um item do Infinity como vieram do modelo ({ nome_do_campo: valor }),
// em uma linha. O cartão precisa mostrar TODOS os valores que vão ser gravados.
export function camposInfinity(campos) {
  if (!campos || typeof campos !== 'object') return '';
  return Object.entries(campos)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v)}`)
    .join('; ');
}

export const IDIOMAS_TEXTO = ['en', 'es'];

// ── Data e hora ─────────────────────────────────────────────────────────────
// Mesma regra do formatWhen do confirm.mjs: mostra o horário de PAREDE como
// veio no ISO, sem converter fuso (converter distorcia a hora de quem está
// fora de São Paulo).
//
// Em inglês o dia NÃO pode sair como número: "09/07/2026" é 9 de julho pra
// quem lê DD/MM e 7 de setembro pra quem lê MM/DD, e aqui o usuário está
// aprovando um horário de agenda. Mês por nome resolve a ambiguidade.
const MES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function quando(s, lang) {
  if (!s || typeof s !== 'string') return '';
  const str = s.trim();
  const dOnly = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dt = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  const m = dOnly || dt;
  if (!m) return str;
  const [, ano, mes, dia] = m;
  const hora = dt ? `, ${dt[4]}:${dt[5]}` : '';
  if (lang === 'en') {
    const nome = MES_EN[Number(mes) - 1] || mes;
    return `${nome} ${Number(dia)}, ${ano}${hora}`;
  }
  return `${dia}/${mes}/${ano}${hora}`;
}

// ── Cadência de rotina ──────────────────────────────────────────────────────
const DOW = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};

const lista = (nomes, lang) => (nomes.length === 1
  ? nomes[0]
  : `${nomes.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'y'} ${nomes[nomes.length - 1]}`);

function cadencia(args, lang) {
  const cad = normalizeRoutineDays(args);
  if (cad.error || !cad.days) return '';
  const d = parseRoutineDays(cad.days);
  const en = lang === 'en';
  if (d === 'weekdays') return en ? 'Mon–Fri' : 'lun–vie';
  if (d === 'weekends') return en ? 'Sat–Sun' : 'sáb–dom';
  if (Array.isArray(d)) {
    if (d.length === 7) return en ? 'every day' : 'todos los días';
    const nomes = d.map((n) => DOW[lang][n]);
    return en ? `every ${lista(nomes, lang)}` : `todos los ${lista(nomes, lang)}`;
  }
  if (d && typeof d === 'object' && Array.isArray(d.mes)) {
    const nomes = d.mes.map((n) => (n === -1
      ? (en ? 'the last day' : 'el último día')
      : (en ? `day ${n}` : `el día ${n}`)));
    // Diz o que a plataforma faz quando o dia não existe no mês, senão o dono
    // confirma "todo dia 31" achando que fevereiro não recebe nada.
    const curto = d.mes.some((n) => n > 28)
      ? (en ? ' (in shorter months, on the last day)' : ' (en los meses más cortos, el último día)')
      : '';
    return en ? `monthly on ${lista(nomes, lang)}${curto}` : `cada mes ${lista(nomes, lang)}${curto}`;
  }
  if (d && typeof d === 'object' && Array.isArray(d.dow)) {
    const nome = DOW[lang][d.dow[0]];
    if (en) return `${d.nth === -1 ? 'last' : `${d.nth}${[, 'st', 'nd', 'rd'][d.nth] || 'th'}`} ${nome} of the month`;
    return `${d.nth === -1 ? 'el último' : `el ${d.nth}º`} ${nome} del mes`;
  }
  return en ? 'every day' : 'todos los días';
}

function intervalo(min, lang) {
  const m = Number(min);
  const en = lang === 'en';
  if (m % 1440 === 0) { const d = m / 1440; return d === 1 ? (en ? '1 day' : '1 día') : `${d} ${en ? 'days' : 'días'}`; }
  if (m % 60 === 0) { const h = m / 60; return h === 1 ? (en ? '1 hour' : '1 hora') : `${h} ${en ? 'hours' : 'horas'}`; }
  return `${m} min`;
}

// Cadência COMPLETA pro cartão. A rotina tem dois modos (intervalo e horário
// fixo) e o cartão precisa descrever o modo certo: no modo INTERVALO não existe
// hora nem dia, e uma frase de "todo dia às 0?h" descreveria uma rotina que não
// é a que vai ser criada.
function cadenciaFrase(args, lang) {
  const en = lang === 'en';
  const n = Number(args.repetir_cada_min);
  if (Number.isFinite(n) && n > 0) {
    const ate = args.repetir_ate
      ? (en ? ` until ${args.repetir_ate}` : ` hasta ${args.repetir_ate}`)
      : (en ? ' (with no end date)' : ' (sin fecha de término)');
    return `${en ? 'every' : 'cada'} ${intervalo(n, lang)}${ate}`;
  }
  const hora = routineArgsTimeLabel(args, ':') || (en ? '07:00 (default)' : '07:00 (predeterminado)');
  const dias = cadencia(args, lang) || (en ? 'every day' : 'todos los días');
  return en ? `${dias} at ${hora}` : `${dias} a las ${hora}`;
}

// ── Frase do PEDIDO (o que vai ser feito, ainda não foi) ────────────────────
// Infinitivo, porque a frase é encaixada em outra ("I couldn't complete: send
// an email to …"), exatamente como o pt-BR faz.
const PEDIDO = {
  en: {
    gmail_send: (a) => `send an email to ${a.to || '(recipient?)'}${a.subject ? ` with the subject "${a.subject}"` : ''}${copiaLabel(a.cc, 'en')}`,
    hotmail_send: (a) => `send an email (Hotmail/Outlook) to ${a.to || '(recipient?)'}${a.subject ? ` with the subject "${a.subject}"` : ''}${copiaLabel(a.cc, 'en')}`,
    asaas_enviar_comprovante_email: (a) => `send to ${a.para || '(recipient?)'} the official receipt for Asaas operation ${a.id || '(?)'}`,
    gmail_label_delete: (a) => `delete the label "${a.marcador || '(?)'}" from your Gmail (the emails stay, they just lose the label)`,
    gmail_filter_create: (a) => {
      const crit = [a.de && `from ${a.de}`, a.para && `to ${a.para}`, a.assunto && `subject "${a.assunto}"`, a.contem && `containing "${a.contem}"`, a.tem_anexo && 'with an attachment'].filter(Boolean).join(', ');
      const act = [a.marcador && `label "${a.marcador}"`, a.pular_caixa_entrada && 'skip the inbox', a.marcar_lido && 'mark as read', a.marcar_importante && 'mark as important'].filter(Boolean).join(', ');
      return `create a routing rule in Gmail: emails ${crit || '(criteria?)'} → ${act || '(action?)'}`;
    },
    gmail_filter_delete: () => 'delete that routing rule (filter) from your Gmail',
    calendar_create: (a) => `create the event "${a.summary || a.title || '(no title)'}"${a.start ? ` on ${a.start}` : ''}`,
    calendar_update: (a) => {
      const p = [];
      if (a.title != null) p.push(`title to "${a.title}"`);
      if (a.start != null) p.push(`time to ${quando(a.start, 'en')}`);
      if (a.location != null) p.push(`location to "${a.location}"`);
      if (a.description != null) p.push('the description');
      if (a.attendees?.length) p.push('the guests');
      return `edit the event${p.length ? ` (${p.join(', ')})` : ''}`;
    },
    calendar_delete: () => 'delete that event from your calendar',
    outlook_calendar_create: (a) => `create the event "${a.titulo || '(no title)'}" on your Outlook calendar${a.inicio ? ` on ${quando(a.inicio, 'en')}` : ''}`,
    outlook_calendar_update: (a) => {
      const p = [];
      if (a.titulo != null) p.push(`title to "${a.titulo}"`);
      if (a.inicio != null) p.push(`time to ${quando(a.inicio, 'en')}`);
      if (a.local != null) p.push(`location to "${a.local}"`);
      if (a.descricao != null) p.push('the description');
      if (a.convidados != null) p.push('the guests');
      return `edit the event on your Outlook calendar${p.length ? ` (${p.join(', ')})` : ''}`;
    },
    outlook_calendar_delete: () => 'delete that event from your Outlook calendar',
    drive_upload: (a) => `upload the file "${a.name || a.filename || '(no name)'}" to your Drive`,
    drive_upload_arquivo: (a) => `${a.overwrite === true ? 'update the existing' : 'save the'} file "${a.nome || '(no name)'}" in your Drive${a.overwrite === true ? ', keeping the same link' : ''}`,
    enviar_para_drive: (a) => `${a.overwrite === true ? 'update the existing' : 'save the'} file${a.nome ? ` "${a.nome}"` : ''} in your Google Drive${a.overwrite === true ? ', keeping the same link' : ''}`,
    docs_create: (a) => `${a.overwrite === true ? 'update the existing' : 'create the'} Google Doc "${a.name || '(no name)'}" in your Drive${a.overwrite === true ? ', keeping the same link' : ''}`,
    drive_export_pdf: (a) => `export that Google file to PDF and save it in your Drive${a.name ? ` as "${String(a.name).replace(/\.pdf$/i, '')}.pdf"` : ''}`,
    onedrive_upload: (a) => `upload the file "${a.nome || '(no name)'}" to your OneDrive`,
    github_create_issue: (a) => `create an issue on GitHub${a.repo ? ` in ${a.repo}` : ''}: "${a.title || ''}"`,
    github_comment_issue: (a) => `comment on issue ${a.repo || ''}#${a.number ?? a.issue ?? ''}`,
    slack_post_message: (a) => `post a message on Slack${a.channel ? ` (channel ${a.channel})` : ''}`,
    linkedin_post: (a) => `post on your LinkedIn (${a.visibility === 'CONNECTIONS' ? 'connections' : 'public'})`
      + `: "${String(a.text || '').slice(0, 280)}"${a.link ? ` (with the link ${a.link})` : ''}`,
    confirmar_com_agente: (a) => `confirm with ${a.contato || '(contact?)'}'s assistant: "${a.decisao || ''}"`,
    responder_decisao: (a) => `${a.aceito ? 'accept' : 'decline'} the decision${a.de ? ` from ${a.de}` : ''}${a.mensagem ? `: "${a.mensagem}"` : ''}`,
    rodar_no_servidor: (a) => `run the command \`${a.comando || ''}\` on the server${a.host ? ` ${a.host}` : ''}`,
    editar_arquivo: (a) => `edit the file ${a.caminho || '(?)'}${a.host ? ` on ${a.host}` : ''} (replace a section)`,
    escrever_arquivo: (a) => `write the file ${a.caminho || '(?)'}${a.host ? ` on ${a.host}` : ''} (creates it or overwrites the whole thing)`,
    rodar_comando: (a) => `run the command \`${a.comando || ''}\` on the server${a.host ? ` ${a.host}` : ''}`,
    git_commit: (a) => `make a commit${a.diretorio ? ` in ${a.diretorio}` : ''} with the message "${a.mensagem || ''}"${a.adicionar_tudo === false ? ' (only what is already staged)' : ' (git add -A first)'}`,
    git_push: (a) => `git push${a.branch ? ` branch ${a.branch}` : ' the current branch'} to remote ${a.remote || 'origin'}${a.diretorio ? ` (${a.diretorio})` : ''}`,
    git_branch: (a) => `create and switch to branch "${a.nome || ''}"${a.base ? ` from ${a.base}` : ''}${a.diretorio ? ` in ${a.diretorio}` : ''}`,
    git_checkout: (a) => `switch to "${a.ref || ''}"${a.diretorio ? ` in ${a.diretorio}` : ''} (git checkout)`,
    gerenciar_tarefa_de_app: a => a.acao==='cancelar' ? `cancel the task for ${a.app || 'the app'}, preserving the draft` : `update the scope of ${a.app || 'the app'} to ${a.modo==='edicao'?'draft editing':'read-only review'}: ${String(a.objetivo||'').replace(/[<>\r\n]/g,' ').slice(0,2000)}. Preserve progress; no publication. Later execution uses account credits`,
    publicar_sistema: (a) => (a.dono
      ? `publish a new version of ${a.dono}'s system "${a.nome_do_sistema || '(no name)'}" (collaboration)`
      : `publish the system "${a.nome_do_sistema || '(no name)'}" (${a.runtime || '?'}) on your subdomain`),
    criar_rotina: (a) => `create the routine "${a.titulo || '(no title)'}", running ${cadenciaFrase(a, 'en')}${a.canal ? `, delivered on ${a.canal}` : ''}`,
    editar_rotina: (a) => {
      const p = [];
      if(a.ativa!==undefined)p.push(a.ativa?'resume':'pause');
      if (a.novo_titulo) p.push(`rename it to "${a.novo_titulo}"`);
      if (a.canal) p.push(`deliver on ${a.canal}`);
      const hora = routineArgsTimeLabel(a, ':');
      if (hora) p.push(hora.startsWith(':') ? `at minute ${hora}` : `at ${hora}`);
      const cad = cadencia(a, 'en');
      if (cad) p.push(cad);
      if (a.o_que_fazer) p.push('change what it does');
      if (a.testar_agora === true) p.push('apply the changes and test now, delivering on the configured channel');
      const alvo = a.titulo ? `"${a.titulo}"` : a.id ? `#${String(a.id).replace(/^#/, '')}` : '"(no title)"';
      return `change the routine ${alvo}${p.length ? ` (${p.join(', ')})` : ''} — the current routine keeps running until you confirm`;
    },
    convidar_colaborador: (a) => `give ${a.contato || '(contact?)'} COLLABORATION access to your system "${a.nome_do_sistema || '(no name)'}" (they will be able to edit the code and operate the SAME data)`,
    convidar_para_espaco: (a) => `invite ${a.contato || '(contact?)'} to your Space "${a.espaco || '(no name)'}" (they will see and write to the Space's live data)`,
    instalar_skill: (a) => `install the Skill "${a.skill || '(no name)'}"${a.de ? ` from ${a.de}` : ''} in this assistant (it will start loading that behaviour)`,
    compartilhar_skill: (a) => `share your Skill "${a.skill || '(no name)'}" with ${a.contato || '(contact?)'} (they will be able to install it in their assistant)`,
    rodar_skill: (a) => `run your Skill "${a.skill || '(no name)'}" script in the isolated environment (sandbox)${a.argumento ? ` with the argument "${a.argumento}"` : ''}`,
    canva_criar: (a) => `create this in your Canva: ${a.objetivo || '(no goal)'}`,
    canva_editar: (a) => `change a design in your Canva: ${a.objetivo || '(no goal)'}`,
    notion_create_page: (a) => `create the page "${a.titulo || '(no title)'}" in your Notion`,
    notion_append: () => 'append that text to a page in your Notion',
    infinity_criar_item: (a) => `create a new item in Infinity (board ${a.board_id || '?'}, folder ${a.folder_id || '?'})${camposInfinity(a.campos) ? ` with ${camposInfinity(a.campos)}` : ''}`,
    infinity_editar_item: (a) => `change item ${a.item_id || '?'} in Infinity${camposInfinity(a.campos) ? `: ${camposInfinity(a.campos)}` : ''}${a.folder_id ? ` (moving it to folder ${a.folder_id})` : ''}`,
    infinity_comentar: (a) => `post this comment on item ${a.item_id || '?'} in Infinity, visible to everyone on the board: "${a.texto || ''}"`,
    splitwise_add_expense: (a) => `add the expense "${a.descricao || '(no description)'}" of ${a.moeda || 'BRL'} ${a.valor ?? '?'} to Splitwise, split equally in the group`,
    asaas_receber_pix: (a) => a.valor != null
      ? `GENERATE a PIX copy-and-paste code for R$ ${a.valor} to receive money in your Asaas account. If the account has no active PIX key, a random key will also be created. Before you confirm: the payer will see the holder's full name and masked tax ID to verify the recipient`
      : `PREPARE your Asaas account to receive PIX and show a copy-and-paste code with no fixed amount. If the account has no active PIX key, a random key will also be created. Before you confirm: the payer will see the holder's full name and masked tax ID to verify the recipient`,
    asaas_pagar_conta: (a) => `PAY ${a.valor != null ? `R$ ${a.valor}` : "the bill's own amount"} from your Asaas account (bill/invoice, barcode line ${a.linha_digitavel || a.codigo_de_barras || '(?)'})${a.agendar_para ? `, scheduled for ${a.agendar_para}` : ''} — this is real money and it cannot be undone`,
    asaas_cancelar_pagamento_conta: (a) => `CANCEL bill payment ${a.id || '(missing id)'} from your Asaas account — cancellation is irreversible and, once confirmed by Asaas, prevents the payment from being executed`,
    asaas_transferir_pix: (a) => `TRANSFER R$ ${a.valor ?? '?'} via PIX from your Asaas account to the key ${a.chave_pix || '(?)'} (${a.tipo_chave || '?'})${a.agendar_para ? `, scheduled for ${a.agendar_para}` : ''} — this is real money and it cannot be undone`,
    salvar_credencial: (a) => `store your ${a.servico || '(service?)'} API key in the credential Vault (it is encrypted and never shows up in the chat)`,
    criar_conta_brambs: (a) => [
      `OPEN YOUR REAL ${marca().nome.toUpperCase()} ACCOUNT, in your name:`,
      `• holder: ${a.nome || '(?)'} · ${a.cpf_cnpj || '(?)'}`,
      `• contact: ${a.email || '(?)'} · ${a.celular || '(?)'}`,
      `• address: ${a.endereco || '(?)'}, ${a.numero || '(?)'}${a.complemento ? ` ${a.complemento}` : ''} · ${a.bairro || '(?)'} · ZIP ${a.cep || '(?)'}`,
      `• declared income/revenue: R$ ${a.renda_mensal ?? '(?)'}`,
      '',
      `The account is provided by *Asaas* (they are the payment institution; ${marca().nome} only connects you). Once it is open you still need to send a document and take a selfie on the Asaas screen, and the review takes up to 48h. Opening it cannot be undone from here.`,
    ].join('\n'),
    apagar_sistema: (a) => `PERMANENTLY delete the system "${a.nome_do_sistema || '(no name)'}": container, code, version history AND the data the app stored, including vault secrets and collaborator access. There is no backup and no way back`,
    replicar_sistema: (a) => `replicate the public app "${a.origem || '(source?)'}" on your subdomain${a.novo_nome ? ` as "${a.novo_nome}"` : ''}`,
    voltar_versao: (a) => `roll the system "${a.nome_do_sistema || '(no name)'}" back to version ${a.versao || '(?)'} (the code goes back; the data is preserved)`,
    remover_arquivo_do_app: (a) => `remove the file ${a.caminho || '(?)'} from the draft of the app "${a.nome_do_sistema || '(no name)'}" (does not touch the live app; recoverable by version)`,
    remover_segredo: (a) => `remove the secret "${a.chave || '(?)'}" from the system "${a.nome_do_sistema || '(no name)'}" (the app restarts without that variable; the value cannot be recovered)`,
  },
  es: {
    gmail_send: (a) => `enviar un correo a ${a.to || '(¿destinatario?)'}${a.subject ? ` con el asunto "${a.subject}"` : ''}${copiaLabel(a.cc, 'es')}`,
    hotmail_send: (a) => `enviar un correo (Hotmail/Outlook) a ${a.to || '(¿destinatario?)'}${a.subject ? ` con el asunto "${a.subject}"` : ''}${copiaLabel(a.cc, 'es')}`,
    asaas_enviar_comprovante_email: (a) => `enviar a ${a.para || '(¿destinatario?)'} el comprobante oficial de la operación ${a.id || '(?)'} en Asaas`,
    gmail_label_delete: (a) => `borrar la etiqueta "${a.marcador || '(?)'}" de tu Gmail (los correos se quedan, solo pierden la etiqueta)`,
    gmail_filter_create: (a) => {
      const crit = [a.de && `de ${a.de}`, a.para && `para ${a.para}`, a.assunto && `asunto "${a.assunto}"`, a.contem && `que contengan "${a.contem}"`, a.tem_anexo && 'con adjunto'].filter(Boolean).join(', ');
      const act = [a.marcador && `etiqueta "${a.marcador}"`, a.pular_caixa_entrada && 'saltar la bandeja de entrada', a.marcar_lido && 'marcar como leído', a.marcar_importante && 'marcar como importante'].filter(Boolean).join(', ');
      return `crear una regla de enrutamiento en Gmail: correos ${crit || '(¿criterio?)'} → ${act || '(¿acción?)'}`;
    },
    gmail_filter_delete: () => 'borrar esa regla de enrutamiento (filtro) de tu Gmail',
    calendar_create: (a) => `crear el evento "${a.summary || a.title || '(sin título)'}"${a.start ? ` el ${a.start}` : ''}`,
    calendar_update: (a) => {
      const p = [];
      if (a.title != null) p.push(`título a "${a.title}"`);
      if (a.start != null) p.push(`horario a ${quando(a.start, 'es')}`);
      if (a.location != null) p.push(`lugar a "${a.location}"`);
      if (a.description != null) p.push('la descripción');
      if (a.attendees?.length) p.push('los invitados');
      return `editar el evento${p.length ? ` (${p.join(', ')})` : ''}`;
    },
    calendar_delete: () => 'borrar ese evento de tu calendario',
    outlook_calendar_create: (a) => `crear el evento "${a.titulo || '(sin título)'}" en el calendario de Outlook${a.inicio ? ` el ${quando(a.inicio, 'es')}` : ''}`,
    outlook_calendar_update: (a) => {
      const p = [];
      if (a.titulo != null) p.push(`título a "${a.titulo}"`);
      if (a.inicio != null) p.push(`horario a ${quando(a.inicio, 'es')}`);
      if (a.local != null) p.push(`lugar a "${a.local}"`);
      if (a.descricao != null) p.push('la descripción');
      if (a.convidados != null) p.push('los invitados');
      return `editar el evento en el calendario de Outlook${p.length ? ` (${p.join(', ')})` : ''}`;
    },
    outlook_calendar_delete: () => 'borrar ese evento del calendario de Outlook',
    drive_upload: (a) => `subir el archivo "${a.name || a.filename || '(sin nombre)'}" a tu Drive`,
    drive_upload_arquivo: (a) => `${a.overwrite === true ? 'actualizar el archivo existente' : 'guardar el archivo'} "${a.nome || '(sin nombre)'}" en tu Drive${a.overwrite === true ? ', conservando el mismo enlace' : ''}`,
    enviar_para_drive: (a) => `${a.overwrite === true ? 'actualizar el archivo existente' : 'guardar el archivo'}${a.nome ? ` "${a.nome}"` : ''} en tu Google Drive${a.overwrite === true ? ', conservando el mismo enlace' : ''}`,
    docs_create: (a) => `${a.overwrite === true ? 'actualizar el documento existente' : 'crear el Google Doc'} "${a.name || '(sin nombre)'}" en tu Drive${a.overwrite === true ? ', conservando el mismo enlace' : ''}`,
    drive_export_pdf: (a) => `exportar ese archivo de Google a PDF y guardarlo en tu Drive${a.name ? ` como "${String(a.name).replace(/\.pdf$/i, '')}.pdf"` : ''}`,
    onedrive_upload: (a) => `subir el archivo "${a.nome || '(sin nombre)'}" a tu OneDrive`,
    github_create_issue: (a) => `crear un issue en GitHub${a.repo ? ` en ${a.repo}` : ''}: "${a.title || ''}"`,
    github_comment_issue: (a) => `comentar en el issue ${a.repo || ''}#${a.number ?? a.issue ?? ''}`,
    slack_post_message: (a) => `publicar un mensaje en Slack${a.channel ? ` (canal ${a.channel})` : ''}`,
    linkedin_post: (a) => `publicar en tu LinkedIn (${a.visibility === 'CONNECTIONS' ? 'contactos' : 'público'})`
      + `: "${String(a.text || '').slice(0, 280)}"${a.link ? ` (con el enlace ${a.link})` : ''}`,
    confirmar_com_agente: (a) => `confirmar con el asistente de ${a.contato || '(¿contacto?)'}: "${a.decisao || ''}"`,
    responder_decisao: (a) => `${a.aceito ? 'aceptar' : 'rechazar'} la decisión${a.de ? ` de ${a.de}` : ''}${a.mensagem ? `: "${a.mensagem}"` : ''}`,
    rodar_no_servidor: (a) => `ejecutar el comando \`${a.comando || ''}\` en el servidor${a.host ? ` ${a.host}` : ''}`,
    editar_arquivo: (a) => `editar el archivo ${a.caminho || '(?)'}${a.host ? ` en ${a.host}` : ''} (reemplazar un fragmento)`,
    escrever_arquivo: (a) => `escribir el archivo ${a.caminho || '(?)'}${a.host ? ` en ${a.host}` : ''} (lo crea o lo sobrescribe por completo)`,
    rodar_comando: (a) => `ejecutar el comando \`${a.comando || ''}\` en el servidor${a.host ? ` ${a.host}` : ''}`,
    git_commit: (a) => `hacer un commit${a.diretorio ? ` en ${a.diretorio}` : ''} con el mensaje "${a.mensagem || ''}"${a.adicionar_tudo === false ? ' (solo lo que ya está en el stage)' : ' (git add -A antes)'}`,
    git_push: (a) => `hacer git push${a.branch ? ` de la rama ${a.branch}` : ' de la rama actual'} al remoto ${a.remote || 'origin'}${a.diretorio ? ` (${a.diretorio})` : ''}`,
    git_branch: (a) => `crear y cambiar a la rama "${a.nome || ''}"${a.base ? ` a partir de ${a.base}` : ''}${a.diretorio ? ` en ${a.diretorio}` : ''}`,
    git_checkout: (a) => `cambiar a "${a.ref || ''}"${a.diretorio ? ` en ${a.diretorio}` : ''} (git checkout)`,
    gerenciar_tarefa_de_app: a => a.acao==='cancelar' ? `cancelar la tarea de ${a.app || 'la app'}, conservando el borrador` : `actualizar el alcance de ${a.app || 'la app'} a ${a.modo==='edicao'?'edición del borrador':'revisión sin edición'}: ${String(a.objetivo||'').replace(/[<>\r\n]/g,' ').slice(0,2000)}. Conserva el progreso; no publica. La ejecución posterior usa créditos de la cuenta`,
    publicar_sistema: (a) => (a.dono
      ? `publicar una nueva versión del sistema "${a.nome_do_sistema || '(sin nombre)'}" de ${a.dono} (colaboración)`
      : `publicar el sistema "${a.nome_do_sistema || '(sin nombre)'}" (${a.runtime || '?'}) en tu subdominio`),
    criar_rotina: (a) => `crear la rutina "${a.titulo || '(sin título)'}", que corre ${cadenciaFrase(a, 'es')}${a.canal ? `, entregando en ${a.canal}` : ''}`,
    editar_rotina: (a) => {
      const p = [];
      if(a.ativa!==undefined)p.push(a.ativa?'reanudar':'pausar');
      if (a.novo_titulo) p.push(`renombrarla a "${a.novo_titulo}"`);
      if (a.canal) p.push(`entregar en ${a.canal}`);
      const hora = routineArgsTimeLabel(a, ':');
      if (hora) p.push(hora.startsWith(':') ? `en el minuto ${hora}` : `a las ${hora}`);
      const cad = cadencia(a, 'es');
      if (cad) p.push(cad);
      if (a.o_que_fazer) p.push('cambiar lo que hace');
      if (a.testar_agora === true) p.push('aplicar los cambios y probar ahora, entregando en el canal configurado');
      const alvo = a.titulo ? `"${a.titulo}"` : a.id ? `#${String(a.id).replace(/^#/, '')}` : '"(sin título)"';
      return `modificar la rutina ${alvo}${p.length ? ` (${p.join(', ')})` : ''}, la rutina actual sigue valiendo hasta que confirmes`;
    },
    convidar_colaborador: (a) => `dar a ${a.contato || '(¿contacto?)'} acceso de COLABORACIÓN a tu sistema "${a.nome_do_sistema || '(sin nombre)'}" (podrá editar el código y operar los MISMOS datos)`,
    convidar_para_espaco: (a) => `invitar a ${a.contato || '(¿contacto?)'} a tu Space "${a.espaco || '(sin nombre)'}" (podrá ver y anotar en los datos vivos del Space)`,
    instalar_skill: (a) => `instalar la Skill "${a.skill || '(sin nombre)'}"${a.de ? ` de ${a.de}` : ''} en este asistente (empezará a cargar ese comportamiento)`,
    compartilhar_skill: (a) => `compartir tu Skill "${a.skill || '(sin nombre)'}" con ${a.contato || '(¿contacto?)'} (podrá instalarla en su asistente)`,
    rodar_skill: (a) => `ejecutar el script de tu Skill "${a.skill || '(sin nombre)'}" en el entorno aislado (sandbox)${a.argumento ? ` con el argumento "${a.argumento}"` : ''}`,
    canva_criar: (a) => `crear esto en tu Canva: ${a.objetivo || '(sin objetivo)'}`,
    canva_editar: (a) => `modificar un diseño en tu Canva: ${a.objetivo || '(sin objetivo)'}`,
    notion_create_page: (a) => `crear la página "${a.titulo || '(sin título)'}" en tu Notion`,
    notion_append: () => 'agregar ese texto a una página de tu Notion',
    infinity_criar_item: (a) => `crear un elemento nuevo en Infinity (tablero ${a.board_id || '?'}, carpeta ${a.folder_id || '?'})${camposInfinity(a.campos) ? ` con ${camposInfinity(a.campos)}` : ''}`,
    infinity_editar_item: (a) => `cambiar el elemento ${a.item_id || '?'} en Infinity${camposInfinity(a.campos) ? `: ${camposInfinity(a.campos)}` : ''}${a.folder_id ? ` (moviéndolo a la carpeta ${a.folder_id})` : ''}`,
    infinity_comentar: (a) => `publicar este comentario en el elemento ${a.item_id || '?'} de Infinity, visible para todos en el tablero: "${a.texto || ''}"`,
    splitwise_add_expense: (a) => `registrar en Splitwise el gasto "${a.descricao || '(sin descripción)'}" de ${a.moeda || 'BRL'} ${a.valor ?? '?'}, dividido en partes iguales en el grupo`,
    asaas_receber_pix: (a) => a.valor != null
      ? `GENERAR un código PIX copia y pega de R$ ${a.valor} para recibir dinero en tu cuenta Asaas. Si la cuenta no tiene una clave PIX activa, también se creará una clave aleatoria. Antes de confirmar: el pagador verá el nombre completo del titular y su documento enmascarado para verificar el destinatario`
      : `PREPARAR tu cuenta Asaas para recibir PIX y mostrar el código copia y pega sin importe fijo. Si la cuenta no tiene una clave PIX activa, también se creará una clave aleatoria. Antes de confirmar: el pagador verá el nombre completo del titular y su documento enmascarado para verificar el destinatario`,
    asaas_pagar_conta: (a) => `PAGAR desde tu cuenta Asaas ${a.valor != null ? `R$ ${a.valor}` : 'el importe del propio recibo'} (boleto/factura, línea digitable ${a.linha_digitavel || a.codigo_de_barras || '(?)'})${a.agendar_para ? `, programado para ${a.agendar_para}` : ''}, es dinero de verdad y no se puede deshacer`,
    asaas_cancelar_pagamento_conta: (a) => `CANCELAR desde tu cuenta Asaas el pago de cuenta ${a.id || '(id no informado)'}, la cancelación es irreversible y, cuando Asaas la confirme, impedirá que se ejecute el pago`,
    asaas_transferir_pix: (a) => `TRANSFERIR R$ ${a.valor ?? '?'} por PIX desde tu cuenta Asaas a la clave ${a.chave_pix || '(?)'} (${a.tipo_chave || '?'})${a.agendar_para ? `, programado para ${a.agendar_para}` : ''}, es dinero de verdad y no se puede deshacer`,
    salvar_credencial: (a) => `guardar tu API key de ${a.servico || '(¿servicio?)'} en la Bóveda de credenciales (queda cifrada y no aparece en el chat)`,
    criar_conta_brambs: (a) => [
      `ABRIR TU CUENTA ${marca().nome.toUpperCase()} de verdad, a tu nombre:`,
      `• titular: ${a.nome || '(?)'} · ${a.cpf_cnpj || '(?)'}`,
      `• contacto: ${a.email || '(?)'} · ${a.celular || '(?)'}`,
      `• dirección: ${a.endereco || '(?)'}, ${a.numero || '(?)'}${a.complemento ? ` ${a.complemento}` : ''} · ${a.bairro || '(?)'} · CP ${a.cep || '(?)'}`,
      `• ingresos/facturación declarados: R$ ${a.renda_mensal ?? '(?)'}`,
      '',
      `La cuenta la provee *Asaas* (es la institución de pago; ${marca().nome} solo te conecta). Después de abrirla tienes que enviar un documento y hacerte la selfie en la pantalla de Asaas, y el análisis tarda hasta 48h. Abrirla no se puede deshacer desde aquí.`,
    ].join('\n'),
    apagar_sistema: (a) => `borrar PARA SIEMPRE el sistema "${a.nome_do_sistema || '(sin nombre)'}": contenedor, código, historial de versiones Y los datos que guardó la app, incluidos los secretos y accesos de colaboradores. No hay copia de seguridad ni forma de volver`,
    replicar_sistema: (a) => `replicar la app pública "${a.origem || '(¿origen?)'}" en tu subdominio${a.novo_nome ? ` como "${a.novo_nome}"` : ''}`,
    voltar_versao: (a) => `volver el sistema "${a.nome_do_sistema || '(sin nombre)'}" a la versión ${a.versao || '(?)'} (el código vuelve; los datos se preservan)`,
    remover_arquivo_do_app: (a) => `quitar el archivo ${a.caminho || '(?)'} del borrador de la app "${a.nome_do_sistema || '(sin nombre)'}" (no toca la app en línea; se puede recuperar por versión)`,
    remover_segredo: (a) => `quitar el secreto "${a.chave || '(?)'}" del sistema "${a.nome_do_sistema || '(sin nombre)'}" (la app se reinicia sin esa variable; el valor no se puede recuperar)`,
  },
};
// Mesma implementação das duas tools de upload do OneDrive, igual ao pt-BR.
PEDIDO.en.onedrive_upload_arquivo = PEDIDO.en.onedrive_upload;
PEDIDO.es.onedrive_upload_arquivo = PEDIDO.es.onedrive_upload;

// `fechar_pedido` fica fora da tabela porque depende do CARRINHO, não dos args:
// o valor que o dono aprova tem que ser o do carrinho montado na loja, não um
// número repetido pelo modelo. O resumo em si (`descreverCarrinho`) segue em
// português nesta fase: traduzir aquilo é mexer no subsistema de compras.
PEDIDO.en.fechar_pedido = (a) => {
  const resumo = descreverCarrinho(a.carrinho_id);
  if (!resumo) return 'PLACE A REAL ORDER at the store (but the cart no longer exists, so it has to be built again first)';
  if (plataformaDoCarrinho(a.carrinho_id) !== 'vtex') {
    return `open the store checkout with this cart ready (${resumo}). At this store you are the one who completes the payment, on their screen; I do not create the order and I do not charge anything`;
  }
  return `PLACE THE ORDER FOR REAL: ${resumo}. This creates a real order in your name and generates the charge; it cannot be undone from here`;
};
PEDIDO.es.fechar_pedido = (a) => {
  const resumo = descreverCarrinho(a.carrinho_id);
  if (!resumo) return 'HACER UN PEDIDO DE VERDAD en la tienda (pero el carrito ya no existe, así que hay que armarlo de nuevo antes)';
  if (plataformaDoCarrinho(a.carrinho_id) !== 'vtex') {
    return `abrir el checkout de la tienda con este carrito listo (${resumo}). En esta tienda el pago lo terminas tú, en su pantalla; yo no creo el pedido ni cobro nada`;
  }
  return `HACER EL PEDIDO DE VERDAD: ${resumo}. Esto crea un pedido real a tu nombre y genera el cobro; no se puede deshacer desde aquí`;
};

// ── Frase do FEITO (passado, é o que o usuário recebe depois do "pode") ─────
const FEITO = {
  en: {
    gmail_send: (a) => `Email sent to ${a.to || 'the recipient'}${a.subject ? ` with the subject "${a.subject}"` : ''}${copiaLabel(a.cc, 'en')}.`,
    hotmail_send: (a) => `Email (Hotmail/Outlook) sent to ${a.to || 'the recipient'}${a.subject ? ` with the subject "${a.subject}"` : ''}${copiaLabel(a.cc, 'en')}.`,
    gmail_label_delete: (a) => `Label "${a.marcador || ''}" deleted from your Gmail.`,
    gmail_filter_create: () => 'Routing rule created in your Gmail (it applies to incoming emails from now on).',
    gmail_filter_delete: () => 'Routing rule deleted from your Gmail.',
    calendar_create: (a) => {
      const w = quando(a.start, 'en');
      const tz = a.timezone ? ` (${a.timezone})` : '';
      return `Event "${a.summary || a.title || 'no title'}" created on your calendar${w ? ` for ${w}${tz}` : ''}.`;
    },
    calendar_update: (a) => {
      const p = [];
      if (a.title != null) p.push(`title "${a.title}"`);
      if (a.start != null) p.push(`time ${quando(a.start, 'en')}${a.timezone ? ` (${a.timezone})` : ''}`);
      if (a.location != null) p.push(`location "${a.location}"`);
      if (a.description != null) p.push('description');
      if (a.attendees?.length) p.push('guests');
      return `Event updated${p.length ? `: ${p.join(', ')}` : ''}.`;
    },
    calendar_delete: () => 'Event deleted from your calendar.',
    outlook_calendar_create: (a) => {
      const w = quando(a.inicio, 'en');
      return `Event "${a.titulo || 'no title'}" created on your Outlook calendar${w ? ` for ${w}` : ''}.`;
    },
    outlook_calendar_update: (a) => {
      const p = [];
      if (a.titulo != null) p.push(`title "${a.titulo}"`);
      if (a.inicio != null) p.push(`time ${quando(a.inicio, 'en')}`);
      if (a.local != null) p.push(`location "${a.local}"`);
      if (a.descricao != null) p.push('description');
      if (a.convidados != null) p.push('guests');
      return `Outlook event updated${p.length ? `: ${p.join(', ')}` : ''}.`;
    },
    outlook_calendar_delete: () => 'Event deleted from your Outlook calendar.',
    drive_upload: (a) => `File "${a.name || a.filename || 'no name'}" uploaded to your Drive.`,
    drive_upload_arquivo: (a) => `File "${a.nome || 'no name'}" uploaded to your Drive.`,
    enviar_para_drive: (a) => `Copy${a.nome ? ` of "${a.nome}"` : ''} sent to your Google Drive.`,
    docs_create: (a) => `Google Doc "${a.name || 'no name'}" created in your Drive.`,
    drive_export_pdf: () => 'PDF generated and saved in your Drive.',
    onedrive_upload: (a) => `File "${a.nome || 'no name'}" uploaded to your OneDrive.`,
    github_create_issue: (a) => `Issue created${a.repo ? ` in ${a.repo}` : ''}: "${a.title || ''}".`,
    github_comment_issue: (a) => `Comment posted on issue ${a.repo || ''}#${a.number ?? a.issue ?? ''}.`,
    slack_post_message: (a) => `Message posted on Slack${a.channel ? ` (channel ${a.channel})` : ''}.`,
    linkedin_post: () => 'Post published on your LinkedIn.',
    confirmar_com_agente: (a) => `Decision sent to ${a.contato || 'your contact'}'s assistant.`,
    responder_decisao: (a) => `${a.aceito ? 'Acceptance' : 'Refusal'} sent to the contact's assistant.`,
    rodar_no_servidor: (a) => `Command executed on the server${a.host ? ` ${a.host}` : ''}.`,
    editar_arquivo: (a) => `File ${a.caminho || ''} edited.`,
    escrever_arquivo: (a) => `File ${a.caminho || ''} written.`,
    rodar_comando: (a) => `Command executed on the server${a.host ? ` ${a.host}` : ''}.`,
    git_commit: (a) => `Commit made${a.diretorio ? ` in ${a.diretorio}` : ''}: "${a.mensagem || ''}".`,
    git_push: (a) => `Pushed${a.branch ? ` branch ${a.branch}` : ' the current branch'} to remote ${a.remote || 'origin'}.`,
    git_branch: (a) => `Branch "${a.nome || ''}" created and checked out.`,
    git_checkout: (a) => `Switched to "${a.ref || ''}".`,
    gerenciar_tarefa_de_app: a => a.acao==='cancelar' ? 'Task canceled; draft preserved.' : 'Scope updated; progress and usage preserved. Nothing was edited, tested or published. Ask to continue when ready.',
    publicar_sistema: (a) => `System "${a.nome_do_sistema || ''}" published on your subdomain.`,
    apagar_sistema: (a) => `System "${a.nome_do_sistema || ''}" permanently deleted (code, history, app data, vault secrets and collaborator access). It cannot be recovered.`,
    replicar_sistema: (a) => `App replicated on your subdomain${a.novo_nome ? ` as "${a.novo_nome}"` : ''}.`,
    voltar_versao: (a) => `System "${a.nome_do_sistema || ''}" rolled back to version ${a.versao || ''}.`,
    criar_rotina: (a) => `Routine "${a.titulo || 'no title'}" created: runs ${cadenciaFrase(a, 'en')}${a.canal ? ` (delivered on ${a.canal})` : ''}. I will run it on my own from the next time it comes due.`,
    editar_rotina: (a) => `Routine ${a.novo_titulo || a.titulo ? `"${a.novo_titulo || a.titulo}"` : `#${String(a.id || '').replace(/^#/, '')}`} updated in place (the old version kept running normally until now).`,
    convidar_colaborador: (a) => `${a.contato || 'The contact'} now collaborates on the system "${a.nome_do_sistema || ''}" (edits the code and operates the same data).`,
    convidar_para_espaco: (a) => `${a.contato || 'The contact'} is now part of the Space "${a.espaco || ''}".`,
    instalar_skill: (a) => `Skill "${a.skill || ''}"${a.de ? ` from ${a.de}` : ''} installed in this assistant.`,
    compartilhar_skill: (a) => `Skill "${a.skill || ''}" shared with ${a.contato || 'the contact'} (they can install it now).`,
    rodar_skill: (a) => `Skill "${a.skill || ''}" script executed in the sandbox.`,
    canva_criar: () => 'Ready in your Canva.',
    canva_editar: () => 'Design changed in your Canva.',
    notion_create_page: (a) => `Page "${a.titulo || ''}" created in your Notion.`,
    notion_append: () => 'Text appended to the page in your Notion.',
    infinity_criar_item: () => 'Item created in Infinity.',
    infinity_editar_item: () => 'Item updated in Infinity.',
    infinity_comentar: () => 'Comment posted in Infinity.',
    splitwise_add_expense: (a) => `Expense "${a.descricao || ''}" (${a.moeda || 'BRL'} ${a.valor ?? ''}) added to Splitwise, split equally.`,
    asaas_receber_pix: () => 'PIX receiving details prepared in your Asaas account.',
    asaas_pagar_conta: (a) => `Payment${a.valor != null ? ` of R$ ${a.valor}` : ''} sent from your Asaas account${a.agendar_para ? ` (scheduled for ${a.agendar_para})` : ''}. Check the status on the receipt.`,
    asaas_cancelar_pagamento_conta: () => 'Bill payment cancelled by Asaas. It will not be executed.',
    asaas_transferir_pix: (a) => `PIX of R$ ${a.valor ?? ''} sent from your Asaas account to the key ${a.chave_pix || ''}${a.agendar_para ? ` (scheduled for ${a.agendar_para})` : ''}.`,
    asaas_enviar_comprovante_email: (a) => `Receipt emailed to ${a.para || 'the recipient'}.`,
    salvar_credencial: (a) => `${a.servico || 'Service'} API key stored in the Vault (encrypted).`,
    // Só o cabeçalho: o detalhe (número, total, Pix) vem no corpo que a própria
    // tool devolve, e o renderConfirmed cola aqui embaixo.
    fechar_pedido: () => 'Order placed at the store. Only the payment is left:',
    criar_conta_brambs: () => `${marca().nome} account opened at Asaas. The documentation is still missing:`,
    // O pt-BR não tem frase própria pra estas duas (cai no genérico "Ação X
    // concluída"). Aqui elas ganham frase mesmo assim: o genérico é a última
    // rede, não o texto desejado.
    remover_arquivo_do_app: (a) => `File ${a.caminho || ''} removed from the draft of "${a.nome_do_sistema || ''}".`,
    remover_segredo: (a) => `Secret "${a.chave || ''}" removed from the system "${a.nome_do_sistema || ''}".`,
  },
  es: {
    gmail_send: (a) => `Correo enviado a ${a.to || 'el destinatario'}${a.subject ? ` con el asunto "${a.subject}"` : ''}${copiaLabel(a.cc, 'es')}.`,
    hotmail_send: (a) => `Correo (Hotmail/Outlook) enviado a ${a.to || 'el destinatario'}${a.subject ? ` con el asunto "${a.subject}"` : ''}${copiaLabel(a.cc, 'es')}.`,
    gmail_label_delete: (a) => `Etiqueta "${a.marcador || ''}" borrada de tu Gmail.`,
    gmail_filter_create: () => 'Regla de enrutamiento creada en tu Gmail (vale para los próximos correos).',
    gmail_filter_delete: () => 'Regla de enrutamiento borrada de tu Gmail.',
    calendar_create: (a) => {
      const w = quando(a.start, 'es');
      const tz = a.timezone ? ` (${a.timezone})` : '';
      return `Evento "${a.summary || a.title || 'sin título'}" creado en tu calendario${w ? ` para el ${w}${tz}` : ''}.`;
    },
    calendar_update: (a) => {
      const p = [];
      if (a.title != null) p.push(`título "${a.title}"`);
      if (a.start != null) p.push(`horario ${quando(a.start, 'es')}${a.timezone ? ` (${a.timezone})` : ''}`);
      if (a.location != null) p.push(`lugar "${a.location}"`);
      if (a.description != null) p.push('descripción');
      if (a.attendees?.length) p.push('invitados');
      return `Evento actualizado${p.length ? `: ${p.join(', ')}` : ''}.`;
    },
    calendar_delete: () => 'Evento borrado de tu calendario.',
    outlook_calendar_create: (a) => {
      const w = quando(a.inicio, 'es');
      return `Evento "${a.titulo || 'sin título'}" creado en el calendario de Outlook${w ? ` para el ${w}` : ''}.`;
    },
    outlook_calendar_update: (a) => {
      const p = [];
      if (a.titulo != null) p.push(`título "${a.titulo}"`);
      if (a.inicio != null) p.push(`horario ${quando(a.inicio, 'es')}`);
      if (a.local != null) p.push(`lugar "${a.local}"`);
      if (a.descricao != null) p.push('descripción');
      if (a.convidados != null) p.push('invitados');
      return `Evento de Outlook actualizado${p.length ? `: ${p.join(', ')}` : ''}.`;
    },
    outlook_calendar_delete: () => 'Evento borrado del calendario de Outlook.',
    drive_upload: (a) => `Archivo "${a.name || a.filename || 'sin nombre'}" subido a tu Drive.`,
    drive_upload_arquivo: (a) => `Archivo "${a.nome || 'sin nombre'}" subido a tu Drive.`,
    enviar_para_drive: (a) => `Copia${a.nome ? ` de "${a.nome}"` : ''} enviada a tu Google Drive.`,
    docs_create: (a) => `Google Doc "${a.name || 'sin nombre'}" creado en tu Drive.`,
    drive_export_pdf: () => 'PDF generado y guardado en tu Drive.',
    onedrive_upload: (a) => `Archivo "${a.nome || 'sin nombre'}" subido a tu OneDrive.`,
    github_create_issue: (a) => `Issue creado${a.repo ? ` en ${a.repo}` : ''}: "${a.title || ''}".`,
    github_comment_issue: (a) => `Comentario publicado en el issue ${a.repo || ''}#${a.number ?? a.issue ?? ''}.`,
    slack_post_message: (a) => `Mensaje publicado en Slack${a.channel ? ` (canal ${a.channel})` : ''}.`,
    linkedin_post: () => 'Publicación hecha en tu LinkedIn.',
    confirmar_com_agente: (a) => `Decisión enviada al asistente de ${a.contato || 'tu contacto'}.`,
    responder_decisao: (a) => `Respuesta de ${a.aceito ? 'aceptación' : 'rechazo'} enviada al asistente del contacto.`,
    rodar_no_servidor: (a) => `Comando ejecutado en el servidor${a.host ? ` ${a.host}` : ''}.`,
    editar_arquivo: (a) => `Archivo ${a.caminho || ''} editado.`,
    escrever_arquivo: (a) => `Archivo ${a.caminho || ''} escrito.`,
    rodar_comando: (a) => `Comando ejecutado en el servidor${a.host ? ` ${a.host}` : ''}.`,
    git_commit: (a) => `Commit hecho${a.diretorio ? ` en ${a.diretorio}` : ''}: "${a.mensagem || ''}".`,
    git_push: (a) => `Push hecho${a.branch ? ` de la rama ${a.branch}` : ' de la rama actual'} al remoto ${a.remote || 'origin'}.`,
    git_branch: (a) => `Rama "${a.nome || ''}" creada y activa.`,
    git_checkout: (a) => `Cambié a "${a.ref || ''}".`,
    gerenciar_tarefa_de_app: a => a.acao==='cancelar' ? 'Tarea cancelada; borrador conservado.' : 'Alcance actualizado; progreso y consumo conservados. Nada fue editado, probado o publicado. Pide continuar cuando quieras.',
    publicar_sistema: (a) => `Sistema "${a.nome_do_sistema || ''}" publicado en tu subdominio.`,
    apagar_sistema: (a) => `Sistema "${a.nome_do_sistema || ''}" borrado para siempre (código, historial, datos, secretos y accesos de colaboradores). No se puede recuperar.`,
    replicar_sistema: (a) => `App replicada en tu subdominio${a.novo_nome ? ` como "${a.novo_nome}"` : ''}.`,
    voltar_versao: (a) => `Sistema "${a.nome_do_sistema || ''}" revertido a la versión ${a.versao || ''}.`,
    criar_rotina: (a) => `Rutina "${a.titulo || 'sin título'}" creada: corre ${cadenciaFrase(a, 'es')}${a.canal ? ` (entrega en ${a.canal})` : ''}. La voy a ejecutar sola a partir de la próxima vez que toque.`,
    editar_rotina: (a) => `Rutina ${a.novo_titulo || a.titulo ? `"${a.novo_titulo || a.titulo}"` : `#${String(a.id || '').replace(/^#/, '')}`} actualizada en su lugar (la versión anterior corrió normalmente hasta ahora).`,
    convidar_colaborador: (a) => `${a.contato || 'El contacto'} ya colabora en el sistema "${a.nome_do_sistema || ''}" (edita el código y opera los mismos datos).`,
    convidar_para_espaco: (a) => `${a.contato || 'El contacto'} ya participa en el Space "${a.espaco || ''}".`,
    instalar_skill: (a) => `Skill "${a.skill || ''}"${a.de ? ` de ${a.de}` : ''} instalada en este asistente.`,
    compartilhar_skill: (a) => `Skill "${a.skill || ''}" compartida con ${a.contato || 'el contacto'} (ya puede instalarla).`,
    rodar_skill: (a) => `Script de la Skill "${a.skill || ''}" ejecutado en el sandbox.`,
    canva_criar: () => 'Listo en tu Canva.',
    canva_editar: () => 'Diseño modificado en tu Canva.',
    notion_create_page: (a) => `Página "${a.titulo || ''}" creada en tu Notion.`,
    notion_append: () => 'Texto agregado a la página de tu Notion.',
    infinity_criar_item: () => 'Elemento creado en Infinity.',
    infinity_editar_item: () => 'Elemento actualizado en Infinity.',
    infinity_comentar: () => 'Comentario publicado en Infinity.',
    splitwise_add_expense: (a) => `Gasto "${a.descricao || ''}" (${a.moeda || 'BRL'} ${a.valor ?? ''}) registrado en Splitwise, dividido en partes iguales.`,
    asaas_receber_pix: () => 'Datos para recibir PIX preparados en tu cuenta Asaas.',
    asaas_pagar_conta: (a) => `Pago${a.valor != null ? ` de R$ ${a.valor}` : ''} enviado desde tu cuenta Asaas${a.agendar_para ? ` (programado para ${a.agendar_para})` : ''}. Revisa el estado en el comprobante.`,
    asaas_cancelar_pagamento_conta: () => 'Pago de cuenta cancelado por Asaas. No se ejecutará.',
    asaas_transferir_pix: (a) => `PIX de R$ ${a.valor ?? ''} enviado desde tu cuenta Asaas a la clave ${a.chave_pix || ''}${a.agendar_para ? ` (programado para ${a.agendar_para})` : ''}.`,
    asaas_enviar_comprovante_email: (a) => `Comprobante enviado por correo a ${a.para || 'el destinatario'}.`,
    salvar_credencial: (a) => `API key de ${a.servico || 'servicio'} guardada en la Bóveda (cifrada).`,
    fechar_pedido: () => 'Pedido hecho en la tienda. Solo falta el pago:',
    criar_conta_brambs: () => `Cuenta ${marca().nome} abierta en Asaas. Falta la documentación:`,
    remover_arquivo_do_app: (a) => `Archivo ${a.caminho || ''} quitado del borrador de "${a.nome_do_sistema || ''}".`,
    remover_segredo: (a) => `Secreto "${a.chave || ''}" quitado del sistema "${a.nome_do_sistema || ''}".`,
  },
};
FEITO.en.onedrive_upload_arquivo = FEITO.en.onedrive_upload;
FEITO.es.onedrive_upload_arquivo = FEITO.es.onedrive_upload;

// ── Moldura do renderConfirmed ──────────────────────────────────────────────
// As frases que envolvem o resultado. `falhou` embute a frase do PEDIDO, que é
// o único texto do cartão que o usuário lê direto do código no caminho de erro.
// `acaoPedido`/`acaoFeita` são o genérico: a rede que pega uma tool que entrou
// no portão mas ainda não tem frase própria. Sem eles o caminho caía no
// `default` em português das funções do confirm.mjs, e uma tool nova apareceria
// em português no cartão de um usuário de inglês sem erro nenhum aparecendo.
export const MOLDURA = {
  en: {
    falhou: (label) => `I couldn't finish: ${label}.`,
    acaoPedido: (name) => `run the action "${name}"`,
    acaoFeita: (name) => `Action "${name}" completed.`,
    stderr: '_stderr:_',
  },
  es: {
    falhou: (label) => `No pude terminar: ${label}.`,
    acaoPedido: (name) => `ejecutar la acción "${name}"`,
    acaoFeita: (name) => `Acción "${name}" completada.`,
    stderr: '_stderr:_',
  },
};

// ── Portas de entrada ───────────────────────────────────────────────────────
// Devolvem null quando não há tradução pro par (idioma, tool). O chamador cai
// no pt-BR, que é o comportamento de hoje: idioma sem tradução nunca pode virar
// texto vazio nem "undefined" num cartão que autoriza gastar dinheiro.
// Sem tradução pra este par (idioma, tool) devolve null e o chamador cai no
// português DETALHADO, de propósito. A tentação é devolver o genérico
// traduzido ("run the action asaas_transferir_pix"), que sai na língua certa;
// mas aí o cartão perde o valor e a chave PIX, e o dono autoriza no escuro.
// Entre frase certa na língua errada e frase vazia na língua certa, o portão
// tem que mostrar a ação real. O genérico traduzido só entra onde o próprio
// pt-BR também é genérico (ver acaoPedido/acaoFeita).
export function pedidoEm(lang, name, args = {}) {
  if (['en','es'].includes(lang) && name === 'jornada_refazer_devolutiva') return retryLabel(lang);
  if (['en','es'].includes(lang) && name === 'jornada_concluir') return completionLabel(lang);
  if (['en','es'].includes(lang) && name === 'jornada_configurar') return configurationLabel(args, lang);
  if (['en','es'].includes(lang) && name === 'jornada_editar_nota') return lang === 'en' ? (args.action === 'delete' ? 'delete the selected temporary note, keeping normal chat history' : `correct the selected temporary note to: ${args.text || '(text missing)'}`) : (args.action === 'delete' ? 'borrar la nota temporal seleccionada, conservando el historial normal' : `corregir la nota temporal seleccionada: ${args.text || '(falta texto)'}`);
  const f = PEDIDO[lang]?.[name];
  if (!f) return portaoTexto(lang, name, args, 0);
  try { return f(args); } catch { return null; }
}

export function feitoEm(lang, name, args = {}) {
  if (['en','es'].includes(lang) && name === 'jornada_concluir') return lang === 'en' ? `Journey completed. I’m preparing practical ways ${marca().nome} can help and will let you know here when they are ready.` : `Recorrido concluido. Estoy preparando ideas prácticas con ${marca().nome} y te avisaré aquí cuando estén listas.`;
  if (['en','es'].includes(lang) && name === 'jornada_refazer_devolutiva') return lang === 'en' ? 'I’m preparing your final report again. I’ll let you know here when it is ready.' : 'Estoy preparando tu devolución nuevamente. Te avisaré aquí cuando esté lista.';
  if (['en','es'].includes(lang) && name === 'jornada_configurar') return lang === 'en' ? 'Discovery journey configured as confirmed.' : 'Recorrido de descubrimiento configurado según la confirmación.';
  if (['en','es'].includes(lang) && name === 'jornada_editar_nota') return lang === 'en' ? 'Temporary note updated as confirmed. Normal chat history remains.' : 'Nota temporal actualizada según la confirmación. El historial normal permanece.';
  const f = FEITO[lang]?.[name];
  if (!f) return portaoTexto(lang, name, args, 1);
  try { return f(args); } catch { return null; }
}

export function molduraEm(lang) {
  return MOLDURA[lang] || null;
}

// Só pro teste: permite conferir que as tabelas cobrem as MESMAS tools que o
// pt-BR cobre, sem depender de eu ter lembrado de conferir na mão.
export const _TOOLS_PEDIDO = { en: Object.keys(PEDIDO.en), es: Object.keys(PEDIDO.es) };
export const _TOOLS_FEITO = { en: Object.keys(FEITO.en), es: Object.keys(FEITO.es) };
