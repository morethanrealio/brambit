import { tagIdioma } from './locale.mjs';

// Fixed texts the server delivers WITHOUT going through the model (credit
// gate, image turned off, confirmation resolved with no model). Since no
// model translates them, they need to exist in all three languages. In pt-BR
// the sentences are byte-for-byte the ones that were already in server.mjs.

const LOCALE = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es-ES' };
const lang = l => (LOCALE[tagIdioma(l)] ? tagIdioma(l) : 'pt-BR');
const num = (n, l) => Number(n || 0).toLocaleString(LOCALE[lang(l)]);

export function imagensDesligadas(l) {
  return {
    'pt-BR': 'A leitura de imagens está desligada nas suas configurações. Liga em *Conexões › Mídia* no app pra eu conseguir ver o que você manda. 🙂',
    en: 'Image reading is turned off in your settings. Turn it on in *Connections › Media* in the app so I can see what you send. 🙂',
    es: 'La lectura de imágenes está desactivada en tu configuración. Actívala en *Conexiones › Multimedia* en la app para que pueda ver lo que me envías. 🙂',
  }[lang(l)];
}

// Business account F1: admin names for text ("Ana", "Ana ou Bruno"). With no
// known name, returns '' and the text is left with just "o admin da empresa".
function listaAdmins(nomes, l) {
  const ns = (Array.isArray(nomes) ? nomes : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!ns.length) return '';
  const ou = { 'pt-BR': ' ou ', en: ' or ', es: ' o ' }[l];
  return ns.length === 1 ? ns[0] : `${ns.slice(0, -1).join(', ')}${ou}${ns[ns.length - 1]}`;
}

// COMPANY credit exhausted. The balance is a single one for all members, so
// everyone gets stuck together. A plain member never gets a purchase link (he
// cannot buy: the route refuses); the text tells him to talk to the admin.
// The admin gets the company's purchase path, which disappears in the iOS app
// under the same 3.1.1 rule. Corporate plan (2026-09-29): no personal plan or
// package for a company. The admin either increases the corporate volume (or
// subscribes, if on Free) or buys the company's one-off credit. The
// corporate planName is already the whole label, so only "corporativo" goes
// in the middle of the sentence.
function avisoCreditoEsgotadoEmpresa(credit, { l, link, appClient, adminNomes }) {
  const fr = num(credit.franchise, l);
  const cap = num(credit.capacity || credit.franchise, l);
  const extra = num(credit.extraAvailable, l);
  const corp = !!credit.corporativo;
  const plano = corp ? { 'pt-BR': 'corporativo', en: 'corporate', es: 'corporativo' }[l] : credit.planName;
  const empresa = credit.account?.orgName || '';
  const admin = credit.account?.role === 'admin';
  const nomes = listaAdmins(adminNomes, l);
  const renova = credit.periodEnd
    ? new Date(credit.periodEnd).toLocaleDateString(LOCALE[l], { day: '2-digit', month: 'long', timeZone: 'America/Sao_Paulo' })
    : null;
  if (l === 'en') {
    const quem = empresa ? `Your company *${empresa}*` : 'Your company';
    const quando = renova ? `renews on ${renova}` : 'renews at the start of the next cycle';
    const fato = credit.extraTotal
      ? `⚠️ ${quem} has run out of credits. This cycle the company had ${cap} credits in total (${fr} from the *${plano}* plan allowance + ${extra} extra credits), and all members together have used them up. The allowance ${quando}; extra credits do not renew.`
      : `⚠️ ${quem} has run out of credits. This cycle all members together used the full ${fr}-credit allowance of the *${plano}* plan. It ${quando}.`;
    if (admin) return appClient ? fato : `${fato} As the company admin, you are the one who buys: to unblock everyone now, ${corp ? 'increase the corporate plan volume' : 'subscribe to the corporate plan'} or buy one-off credits for the company at ${link}`;
    return `${fato} The balance is shared by the whole company, so to keep going before that, talk to the company admin${nomes ? ` (${nomes})` : ''}, who buys credits for everyone.`;
  }
  if (l === 'es') {
    const quem = empresa ? `Se acabaron los créditos de la empresa *${empresa}*` : 'Se acabaron los créditos de la empresa';
    const quando = renova ? `se renueva el ${renova}` : 'se renueva al inicio del próximo ciclo';
    const fato = credit.extraTotal
      ? `⚠️ ${quem}. En este ciclo la empresa tuvo ${cap} créditos en total (${fr} de la franquicia del plan *${plano}* + ${extra} créditos extra) y entre todos los miembros ya los usaron todos. La franquicia ${quando}; los créditos extra no se renuevan.`
      : `⚠️ ${quem}. En este ciclo, entre todos los miembros, usaron toda la franquicia de ${fr} créditos del plan *${plano}*. ${quando[0].toUpperCase()}${quando.slice(1)}.`;
    if (admin) return appClient ? fato : `${fato} Como eres admin de la empresa, la compra es tuya: para liberar a todos ahora, ${corp ? 'aumenta el volumen del plan corporativo' : 'contrata el plan corporativo'} o compra créditos sueltos para la empresa en ${link}`;
    return `${fato} El saldo es uno solo para toda la empresa, así que para seguir antes de eso habla con el admin de la empresa${nomes ? ` (${nomes})` : ''}, que es quien compra créditos para todos.`;
  }
  const quem = empresa ? `O crédito da empresa *${empresa}* acabou` : 'O crédito da empresa acabou';
  const quando = renova ? `renova em ${renova}` : 'renova no início do próximo ciclo';
  const fato = credit.extraTotal
    ? `⚠️ ${quem}. Neste ciclo a empresa teve ${cap} créditos no total (${fr} da franquia do plano *${plano}* + ${extra} de créditos extras) e o uso de todos os membros juntos já consumiu tudo. A franquia ${quando}; os créditos extras não renovam.`
    : `⚠️ ${quem}. Neste ciclo o uso de todos os membros juntos consumiu a franquia inteira de ${fr} créditos do plano *${plano}*. Ela ${quando}.`;
  if (admin) return appClient ? fato : `${fato} Como você é o admin da empresa, a compra é sua: pra liberar todo mundo agora, ${corp ? 'aumente o volume do plano corporativo' : 'assine o plano corporativo'} ou compre créditos avulsos pra empresa em ${link}`;
  return `${fato} O saldo é um só pra empresa toda, então pra continuar antes disso fale com o admin da empresa${nomes ? ` (${nomes})` : ''}, que é quem compra crédito pra todos.`;
}

// End-of-turn note for the emergency case (app recovery with no credit).
// Outside of a company it's the usual note, byte for byte. Member: talk to
// the admin, no link.
export function notaEmergenciaCredito(credit, { language, link, adminNomes = [] } = {}) {
  const l = lang(language);
  if (credit?.account?.kind !== 'org') return TEXTOS[l].notaEmergencia(link);
  const nomes = listaAdmins(adminNomes, l);
  const admin = credit.account.role === 'admin';
  if (l === 'en') {
    return admin
      ? `⚠️ This was an emergency turn (app recovery only). The company has run out of credits. To continue normally, buy one-off credits for the company at ${link}`
      : `⚠️ This was an emergency turn (app recovery only). The company has run out of credits. To continue normally, talk to the company admin${nomes ? ` (${nomes})` : ''}.`;
  }
  if (l === 'es') {
    return admin
      ? `⚠️ Este fue un turno de emergencia (solo para recuperar la app). Se acabaron los créditos de la empresa. Para seguir con normalidad, compra créditos sueltos para la empresa en ${link}`
      : `⚠️ Este fue un turno de emergencia (solo para recuperar la app). Se acabaron los créditos de la empresa. Para seguir con normalidad, habla con el admin de la empresa${nomes ? ` (${nomes})` : ''}.`;
  }
  return admin
    ? `⚠️ Esse foi um turno de emergência (só recuperação do app). O crédito da empresa acabou. Pra continuar normalmente, compre créditos avulsos pra empresa em ${link}`
    : `⚠️ Esse foi um turno de emergência (só recuperação do app). O crédito da empresa acabou. Pra continuar normalmente, fale com o admin da empresa${nomes ? ` (${nomes})` : ''}.`;
}

// credit = getCreditStatus's return. `comprar` disappears in the iOS app
// (Apple's rule 3.1.1: no call-to-purchase outside of In-App Purchase).
// adminNomes: only applies to a company member (credit.account.kind === 'org').
export function avisoCreditoEsgotado(credit, { language, link, appClient = false, adminNomes = [] } = {}) {
  const l = lang(language);
  if (credit?.account?.kind === 'org') return avisoCreditoEsgotadoEmpresa(credit, { l, link, appClient, adminNomes });
  const fr = num(credit.franchise, l);
  const cap = num(credit.capacity || credit.franchise, l);
  const extra = num(credit.extraAvailable, l);
  const plano = credit.planName;
  // REAL renewal date: the cycle is by the person's anniversary, not the 1st.
  const renova = credit.periodEnd
    ? new Date(credit.periodEnd).toLocaleDateString(LOCALE[l], { day: '2-digit', month: 'long', timeZone: 'America/Sao_Paulo' })
    : null;
  if (l === 'en') {
    const quando = renova ? `renews on ${renova}` : 'renews at the start of the next cycle';
    const comprar = appClient ? '' : ` To keep going now, upgrade your plan or buy a credit pack at ${link}`;
    return credit.extraTotal
      ? `⚠️ Your credits have run out. This cycle you had ${cap} credits in total (${fr} from the *${plano}* plan allowance + ${extra} leftover extra credits) and you have used them all. The allowance ${quando}; extra credits do not renew.${comprar}`
      : `⚠️ You have used the full ${fr}-credit allowance of the *${plano}* plan this cycle. It ${quando}.${comprar}`;
  }
  if (l === 'es') {
    const quando = renova ? `se renueva el ${renova}` : 'se renueva al inicio del próximo ciclo';
    const comprar = appClient ? '' : ` Para seguir ahora, mejora tu plan o compra un paquete de créditos en ${link}`;
    return credit.extraTotal
      ? `⚠️ Se te acabaron los créditos. En este ciclo tuviste ${cap} créditos en total (${fr} de la franquicia del plan *${plano}* + ${extra} créditos extra que te quedaban) y ya los usaste todos. La franquicia ${quando}; los créditos extra no se renuevan.${comprar}`
      : `⚠️ Usaste toda la franquicia de ${fr} créditos del plan *${plano}* en este ciclo. ${quando[0].toUpperCase()}${quando.slice(1)}.${comprar}`;
  }
  const quando = renova ? `renova em ${renova}` : 'renova no início do próximo ciclo';
  const comprar = appClient ? '' : ` Pra continuar agora, faça upgrade de plano ou compre um pacote de créditos em ${link}`;
  return credit.extraTotal
    ? `⚠️ Seus créditos acabaram. Neste ciclo você teve ${cap} créditos no total (${fr} da franquia do plano *${plano}* + ${extra} de créditos extras que sobraram) e já consumiu tudo. A franquia ${quando}; os créditos extras não renovam.${comprar}`
    : `⚠️ Você usou toda a franquia de ${fr} créditos do plano *${plano}* neste ciclo. Ela ${quando}.${comprar}`;
}

const TEXTOS = {
  'pt-BR': {
    anexosBloqueados: '⚠️ Os anexos desta mensagem não foram processados nem guardados por este turno. Reenvie-os quando tiver créditos para que eu possa analisá-los.',
    pendenciaCancelada: 'A pendência de confirmação foi cancelada, pois esta mensagem não a confirmou. A ação pendente não foi executada neste turno. Para retomá-la, será necessário fazer um novo pedido.',
    joinhaSemCredito: 'A ação não foi executada: um 👍 não basta para confirmar uma ação irreversível. Ela continua aguardando confirmação por texto (por exemplo, "pode").',
    falhaSemCredito: 'A tentativa de concluir a ação falhou e precisa de análise do assistente, que está bloqueada por falta de créditos. Não houve uma nova tentativa automática. Quando tiver créditos, peça para conferir o que aconteceu antes de tentar novamente.',
    naoConclui: (label, err) => `❌ Não consegui concluir: ${label}. (${err})`,
    notaEmergencia: link => `⚠️ Esse foi um turno de emergência (só recuperação do app). Seus créditos deste mês acabaram — pra continuar normalmente: ${link}`,
    joinhaIrreversivel: label => `Essa é uma ação que não dá pra desfazer (${label}). Um 👍 não basta pra ela: me confirma por *texto* (responde "pode") que aí eu executo.`,
  },
  en: {
    anexosBloqueados: '⚠️ The attachments in this message were not processed or saved in this turn. Send them again once you have credits so I can analyze them.',
    pendenciaCancelada: 'The pending confirmation was canceled because this message did not confirm it. The pending action was not executed in this turn. To resume it, you will need to make a new request.',
    joinhaSemCredito: 'The action was not executed: a 👍 is not enough to confirm an irreversible action. It is still waiting for a text confirmation (for example, "go ahead").',
    falhaSemCredito: 'The attempt to complete the action failed and needs the assistant to look into it, which is blocked because you are out of credits. No automatic retry was made. Once you have credits, ask me to check what happened before trying again.',
    naoConclui: (label, err) => `❌ I could not complete: ${label}. (${err})`,
    notaEmergencia: link => `⚠️ This was an emergency turn (app recovery only). Your credits for this cycle have run out. To continue normally: ${link}`,
    joinhaIrreversivel: label => `This action cannot be undone (${label}). A 👍 is not enough for it: confirm by *text* (reply "go ahead") and I will do it.`,
  },
  es: {
    anexosBloqueados: '⚠️ Los adjuntos de este mensaje no se procesaron ni se guardaron en este turno. Vuelve a enviarlos cuando tengas créditos para que pueda analizarlos.',
    pendenciaCancelada: 'La confirmación pendiente se canceló porque este mensaje no la confirmó. La acción pendiente no se ejecutó en este turno. Para retomarla, tendrás que hacer un nuevo pedido.',
    joinhaSemCredito: 'La acción no se ejecutó: un 👍 no basta para confirmar una acción irreversible. Sigue esperando una confirmación por texto (por ejemplo, "adelante").',
    falhaSemCredito: 'El intento de completar la acción falló y necesita que el asistente lo revise, algo que está bloqueado por falta de créditos. No hubo un nuevo intento automático. Cuando tengas créditos, pídeme que revise lo que pasó antes de volver a intentarlo.',
    naoConclui: (label, err) => `❌ No pude completar: ${label}. (${err})`,
    notaEmergencia: link => `⚠️ Este fue un turno de emergencia (solo para recuperar la app). Se te acabaron los créditos de este ciclo. Para seguir con normalidad: ${link}`,
    joinhaIrreversivel: label => `Esta acción no se puede deshacer (${label}). Un 👍 no basta: confírmame por *texto* (responde "adelante") y la hago.`,
  },
};

export const avisosTurno = l => TEXTOS[lang(l)];
