# Security policy

## Reporting a vulnerability

*Do not open a public issue, PR or discussion.* Use GitHub's private reporting: the
repository's *Security* tab → *Report a vulnerability*. Only maintainers see the
report.

If you can, include: what is affected, how to reproduce it, the impact you see and
the version or commit you tested.

## What happens next

- We acknowledge the report within 3 business days.
- We assess it and reply with our diagnosis within 10 business days.
- We fix it within 90 days of the report. If the fix depends on third parties or is
  large, we tell you before the deadline and agree on a new one.
- We agree with you on the disclosure date. Reporters are credited if they wish.

## Scope

This covers the code in this repository. The hosted service at brambs.com.br also
accepts reports through the same channel; do not run tests that affect other
people's data or accounts, and no load testing.

## Supported versions

Security fixes ship in the latest version. Older versions don't receive fixes.

## Choices a scanner may flag

These are on purpose. A report is still welcome if you find a way around the
limit described.

- *Shell commands in `runner-go/`.* Running commands on the owner's machine is
  what the Runner does. In restricted mode it fences writes (macOS seatbelt,
  Linux bubblewrap) and refuses to run on a machine that can't fence them,
  unless the owner picks full access for that machine.
- *SQL built with template literals.* The interpolated part is the schema name,
  a constant (`S` in `web/db.mjs`). Values go as query parameters.
- *`Math.random` in the 4-digit invite code.* The code is a short invite that
  people type, not a secret key. `POST /api/signup` allows 5 attempts per hour
  per address before it checks the code, and a code only counts while its
  invite has room left.
- *SHA-1 in `web/uuid-de.mjs`.* It builds name-based UUIDs (version 5, RFC
  4122), not a signature or a password hash.
- *`Access-Control-Allow-Origin: *` in `web/hosting.mjs`.* It is inside the
  starter code written for the user's own apps, not in Brambit's server.
- *Any origin accepted on `/api/ext/*`.* The browser extension calls these with
  a Bearer token; no cookie is used and `Access-Control-Allow-Credentials` is
  never sent. The public web channel answers only the websites the owner lists.
- *Install scripts in `embedded-postgres`.* A development dependency that runs a
  local database for `npm run local`; it is not used in production.

## Known limits

- Sign-in has no second factor yet
  ([#27](https://github.com/morethanrealio/brambit/issues/27)).

## Public support safeguards

The owner sets up each assistant that answers the public in `/atendimento`.

- *Spending:* a daily cap per assistant, US$10 unless the owner sets another.
- *Volume:* 30 messages per hour per contact (the owner sets 1 to 600) and
  1000 per hour per assistant, all contacts together (1 to 100000). Past the
  cap or a limit the model is not called and the person gets a fixed reply
  (for the contact's limit, once an hour); past the assistant's limit the
  message is not stored either.
- *Open sign-up:* while anyone can create an account (`BRAMBIT_SIGNUP`), public
  support stays off on every channel, since the number or chat it hands out
  would also hand out accounts paid by the owner. When a plugin decides
  sign-up, the plugin decides this too.
- *Website channel:* a browser is answered only from the sites the owner lists,
  and its contact is a token signed by the installation. A server calls with
  the assistant's key (`bpk_…`, stored as a hash), which the owner can lock to
  the servers' addresses. The contact goes in the `Brambit-Contact` header, not
  in the URL, so it doesn't end up in access logs. Details in
  [docs/public-web.md](docs/public-web.md).
- *Links:* the owner can list the sites the assistant may send people to. A
  button to any other site then becomes plain text, and other sites' addresses
  and e-mail addresses leave the answer. Not checked: WhatsApp templates, data
  outputs and a plugin's fixed answers, which the plugin writes, not the model.
  A word glued after a period ("ok.Thanks") looks like an address and may
  leave too. An empty list checks nothing.
- *Logs:* the WhatsApp module logs a phone number by its last 4 digits.
- *Usage profiles:* `BRAMBIT_PROFILE=public-support` runs only public support:
  everything else answers 404, its background jobs don't start and sign-up is
  always closed. `personal` runs everything except public support.

## Public support and personal data

What Brambit keeps when an assistant answers the public (WhatsApp or the public
web channel), in the installation's own database:

- *Contact:* the phone number or contact id, encrypted (AES-256-GCM, key from
  `VAULT_KEY_ENC` or `VAULT_KEY`), and found by a keyed hash. Without a key
  Brambit refuses to store it.
- *Messages:* the text of the conversation and the page events, not encrypted.
- *Notes:* short notes a plugin keeps about the contact (up to 50, 500
  characters each), not encrypted.

Retention: 90 days after the last message by default; the owner sets 1 to 3650
days per assistant in `/atendimento`. A cleanup runs every 6 hours. A blocked
contact keeps the contact row, so the block holds, but the conversation is
deleted on the same schedule.

The person can send, as the whole message:

- `stop` (or `parar`, `pare`, `sair`, `unsubscribe`): no more replies until
  `start` (or `voltar`);
- `delete my data` (or `apagar meus dados`, `excluir meus dados`): deletes the
  contact with its messages and notes. For a contact the owner blocked, only
  the messages and notes go, so the block holds.

These are handled before the AI model, which can't override them. The owner can
also export (`GET /api/publico/exportar`) or delete (`POST /api/publico/apagar`)
a contact's data.

Who receives what:

- *The AI model provider* the installation uses: the assistant's instructions
  (a plugin's first, then the owner's), the new message and up to the last 40
  messages of that contact. The phone number is not sent.
- *Meta* (WhatsApp Cloud API): the messages, as with any WhatsApp business
  number.
- *The owner:* in `/atendimento`, the contact's number, the conversation and
  the settings.

On WhatsApp the public assistant reads text only; audio, images and documents
get a fixed reply asking for text. Brambit does not tell the person they are
talking to an AI or link a privacy notice. The owner can ask for it in the
assistant's instructions, or a plugin can send it as a fixed first reply
(`antesDoModelo` with `pular` when `primeira` is true).
