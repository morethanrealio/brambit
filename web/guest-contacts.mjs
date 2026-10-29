// Contacts without an account: a message on the installation's WhatsApp number
// from a number no account has linked. The core only keeps the slot; an
// extension answers it (public support, extensions.mjs). With nobody
// registered, the WhatsApp channel keeps its default (the sign-in message).
//
// register({whatsapp: {atende, turno}}, owner): one answerer per installation,
// since the number is a single one. A second one fails at boot.
// whatsapp: what the channel (whatsapp.mjs, `publico`) calls. atende() → whether
// someone answers now; turno({endereco, mensagem, imagens?}) → the reply.
export function createGuestContacts() {
  let answerer = null;
  return {
    register({ whatsapp }, owner) {
      if (answerer) throw new Error(`Contacts without an account are already answered by ${answerer.owner}; ${owner} can't answer them too`);
      if (typeof whatsapp?.atende !== 'function' || typeof whatsapp?.turno !== 'function') throw new Error(`${owner}: whatsapp needs atende() and turno()`);
      answerer = { owner, whatsapp };
    },
    whatsapp: {
      atende: async () => !!answerer && !!(await answerer.whatsapp.atende()),
      turno: (args) => answerer.whatsapp.turno(args),
    },
  };
}
