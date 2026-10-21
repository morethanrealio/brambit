// Confirm / Cancel buttons under a confirmation card. A press decides that one
// card, found by its id: no words are read, so it never lands on another card
// and never depends on the model understanding a reply. Unlike a 👍, a press is
// an explicit yes to the card it sits under, so it also confirms the actions
// that can't be undone.
import { productI18n } from './i18n.mjs';

const PAYLOAD = /^cc:([yn]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// Fits Telegram's 64-byte callback_data and WhatsApp's button id.
export function buttonPayload(id, confirm) {
  return `cc:${confirm ? 'y' : 'n'}:${id}`;
}

// {id, confirm} from a pressed button, or null when it isn't one of ours.
export function parseButtonPayload(value) {
  const m = PAYLOAD.exec(String(value ?? ''));
  return m ? { id: m[2], confirm: m[1] === 'y' } : null;
}

// The admin turns them off with CONFIRMATION_BUTTONS=0 (read on every card, so
// it applies without a restart); the person then confirms by writing. A button
// already on screen keeps working.
export const buttonsEnabled = () => !/^(0|false|off)$/i.test(String(process.env.CONFIRMATION_BUTTONS ?? '').trim());

// What the adapters draw under one card, in the language of the request.
export function cardButtons(row) {
  if (!row?.id || !buttonsEnabled()) return null;
  const text = key => productI18n().t(`confirm.buttons.${key}`, row.language);
  return { id: row.id, label: row.label,
    confirm: { text: text('confirm'), data: buttonPayload(row.id, true) },
    cancel: { text: text('cancel'), data: buttonPayload(row.id, false) } };
}

// The message a press stands for in the conversation history.
export const buttonMessage = confirm => (confirm ? '👍' : '👎');

// A strict decision for a pressed button: the card it names, or nothing.
export function buttonSelection(rows, button, inputId = null) {
  const prior = inputId && rows.find(r => r.decisionKey === inputId);
  if (prior) return { kind: 'replay', row: prior,
    ...(prior.decisionGroup ? { rows: rows.filter(r => r.decisionGroup === prior.decisionGroup) } : {}) };
  const row = rows.find(r => r.id === button?.id);
  if (!row) return { kind: 'ignore' };
  if (row.state !== 'pending') return { kind: 'replay', row };
  if (!row.presented) return { kind: 'unseen', rows: [row] };
  return { kind: button.confirm ? 'confirm' : 'cancel', row };
}

// Web chat: a press arrives as the payload of the button that was tapped.
export function chatButtonOptions(payload) {
  const button = parseButtonPayload(payload);
  return button ? { viaReaction: true, confirmationTarget: { channel: 'chat', messageId: null }, confirmationButton: button } : {};
}

// Web chat: the buttons of the cards a reply carries, and the reply itself when
// the press decided nothing (an old card in another conversation).
export function chatConfirmations(result) {
  return (result?.confirmationCards || []).map(card => card.buttons).filter(Boolean);
}
export const chatReply = result => (result ? { reply: result.text, attachments: result.attachments, confirmations: chatConfirmations(result) }
  : { reply: '', attachments: [], confirmations: [] });
