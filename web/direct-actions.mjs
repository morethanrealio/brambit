// Which actions in a turn run right away and which wait for the owner's
// confirmation card. Every tool that writes, deletes or talks to third parties
// arrives here through the turn's registry (server.mjs) and leaves wrapped by
// the gate in confirm.mjs, with the narrow exceptions below. Exceptions are
// always decided by the arguments and the channel, never by the model's text.
import { gateTool, GATE_TOOLS } from './confirm.mjs';
import { selfStopOnly } from './routine-stop.mjs';

// Narrow exceptions to the 2026-09-28 audit gate: checking the app's access
// without changing anything, and going back to a MORE restricted permission mode.
const NO_CARD = {
  definir_acesso_sistema: (a) => !a?.acesso,
  definir_modo_permissao: (a) => ['padrao', 'plano'].includes(a?.modo),
};
// A routine has no one to click the card, and these two are how a routine ends
// itself (window closed, a monitor that found what it was looking for).
const ROUTINE_ENDS_ITSELF = new Set(['cancelar_rotina', 'remover_monitor']);

// The owner is the one typing: their own chat in the app, their private
// Telegram bot, their WhatsApp. Email, Slack, devices, webhooks, routines and
// onboarding keep the card, and so does a team assistant.
const OWNER_CHANNELS = new Set(['chat', 'telegram', 'whatsapp']);

const guestList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/))
  .map((v) => String(v ?? '').trim()).filter(Boolean);

// Actions the owner asked for that only touch the owner: they run when asked,
// with no card. Anything that sends, invites, deletes, publishes or pays is not
// here and keeps the confirmation.
const OWNER_ONLY = {
  criar_rotina: () => true,
  editar_rotina: () => true,
  calendar_create: (a) => guestList(a?.attendees).length === 0,
  outlook_calendar_create: (a) => guestList(a?.convidados).length === 0,
  docs_create: () => true,
  drive_upload: () => true,
  anotar_no_espaco: (a, ctx) => ctx.privateSpace?.(a) ?? false,
  editar_nota: (a, ctx) => ctx.privateSpace?.(a) ?? false,
};

// Runs without a card when any of the policies says so. A single policy is
// returned as it is, so a tool that only has its own keeps the same behavior.
function either(...policies) {
  const fns = policies.filter((p) => typeof p === 'function');
  if (fns.length <= 1) return fns[0];
  return async (args) => {
    for (const fn of fns) if ((await fn(args)) === true) return true;
    return false;
  };
}

// ctx: { kind, threadId, gateOpts, agentCategory, privateSpace(args) -> boolean }.
// privateSpace says whether a Space belongs to the owner and has no other member.
export function turnGate(tool, ctx) {
  if (!tool) return tool;
  const { kind, threadId, gateOpts, agentCategory } = ctx;
  const ownerOnly = OWNER_CHANNELS.has(kind) && agentCategory !== 'grupo' && OWNER_ONLY[tool.name];
  const direct = ownerOnly ? (args) => ownerOnly(args, ctx) : null;
  // Already wrapped where it was registered (addGated): wrap the original again
  // with the same options, adding only the direct path.
  if (tool.confirmationTool) {
    if (!direct) return tool;
    const original = tool.confirmationTool;
    return gateTool({ ...original, runWithoutConfirmation: either(original.runWithoutConfirmation, direct) },
      threadId, tool.confirmationOptions);
  }
  if (!GATE_TOOLS.has(tool.name) && tool.requiresConfirmation !== true) return tool;
  if (kind === 'routine' && ROUTINE_ENDS_ITSELF.has(tool.name)) return selfStopOnly(tool);
  const policy = either(tool.runWithoutConfirmation, NO_CARD[tool.name], direct);
  return gateTool(policy ? { ...tool, runWithoutConfirmation: policy } : tool, threadId, gateOpts);
}
