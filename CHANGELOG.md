# Changelog

Notable changes to Brambit, newest first. Versions are git tags; an app pins
one in its `package.json` (`brambit#vX.Y.Z`) and moves to a new one on purpose.
Every entry is something any installation can use: features that serve a
single deployment or client live in that deployment's plugins, not here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Changes merged since the last tag go under "Unreleased".

## [Unreleased]

## [0.2.13] - 2026-10-09

### Fixed
- The email channel no longer answers mail that was not written to the
  assistant. A forwarding rule set up elsewhere could drop a registered
  person's message (for example a reply-all to a client) into the assistant
  mailbox, and the assistant replied to it. Now some address of the mailbox
  domain has to be among the recipients (To/Cc, or the original-recipient
  stamp the catch-all leaves); otherwise the message is ignored.

## [0.2.12] - 2026-10-09

### Fixed
- Spreadsheet edits no longer end with "could not verify" on every date. The
  check compared the date the editor declared with the raw number Excel stores;
  it now compares it with the date the person sees in the cell (day/month and
  month/day both accepted), and a wrong date is still reported.
- The assistant sometimes wrote a tool name as a plain line (for example a
  command with the file name) instead of running it, so nothing happened and
  the person saw a raw command. It now gets one chance to really call the tool
  (with the usual confirmation card); if it still does not, the line is removed.

## [0.2.11] - 2026-10-09

### Fixed
- When an app-building or coding task could not confirm whether its last
  change actually happened (for example, the host did not answer in time),
  it used to stay stuck forever: the task, and everything else asked about
  that app, kept being blocked, with no way out. Now the person can be asked
  whether that change actually happened or not, and that answer (always
  typed and confirmed, never guessed or assumed) unblocks the task so work
  can continue or be cancelled.
- Deleting an app that was built but never published (only saved as a
  draft) used to fail with "system not found," because the deletion only
  checked published apps. It now also finds and discards drafts, scoped to
  that person's own app.
- A card that needs approval (for example, deleting a calendar event) is now
  marked as shown the moment it goes out on WhatsApp or Telegram, like it
  already was on other channels. It used to wait for a delivery confirmation
  that a failed or skipped send could leave unset, so the same card could
  resurface later, attached to an unrelated message.
- A 👍 reaction (or a reply) whose card is no longer there to match (for
  example, after the pair of cards it was sent with has moved on) now falls
  back to the pending list instead of showing the generic "which one"
  listing. When every pending card came from that same request, that
  reaction or a plain "yes" approves them together; cards from
  different requests still ask which one.
- A task big enough to hit the per-turn step limit twice in a row (after the
  person replied "continue" to resume it) no longer gets the exact same
  "say continue" message forever. The second time, the turn gets a one-time,
  bounded increase in its step budget; if the task is still too big after
  that, the assistant proposes splitting the remaining work into smaller
  parts instead of asking to "continue" again.

## [0.2.10] - 2026-10-09

### Fixed
- Changing a reminder that had already gone out, and then creating it again in
  the same turn, no longer ends the reply with "the action was not
  completed" next to the new reminder.
- WhatsApp waits for a voice note, image or document that is still being
  downloaded or transcribed before answering, so a text sent right before it
  and the media become one turn. The text used to be answered alone and the
  media came as a separate turn. The wait is capped at 30 seconds
  (`WA_MEDIA_HOLD_MS`).
- A routine that asks for approval before acting (for example, editing a note
  every week) can now be approved from the Telegram or WhatsApp chat it was
  delivered to. The card used to stay in the routine's own conversation, so a
  reply, a 👍 on the delivered message or a plain "yes" in the chat did not
  reach it, and it expired without running.
- WhatsApp reminders and routines with a list, several lines or more text
  than a template holds no longer arrive squeezed into one line when the
  24h window is closed. The person gets a short notice (through the
  template) saying the content is ready, and any reply brings it formatted,
  as a normal message that enters the conversation history. A bare "ok" or a
  reaction on the notice only releases it, with no extra reply. Held content
  expires after 7 days. Long routines with an e-mail on file keep the
  e-mail path.

## [0.2.9] - 2026-10-09

### Added
- The setup page offers DeepInfra and DeepSeek as AI providers, and shows
  each provider's steps to get a key (account, credit or free tier, key page)
  with links, in the page's language. DeepSeek's own API runs with thinking
  off, as the core's DeepSeek route does.
- The web chat has a microphone button when voice is set up: the person
  speaks, the browser converts the recording to WAV (no ffmpeg needed) and the
  transcript goes to the assistant marked as a voice message, as it does from
  WhatsApp and Telegram. Chats show voice messages as the transcript after 🎤.
- The setup page lists the chat models the key can use, with the recommended
  one selected, and lets the person pick another. When the provider publishes
  the model's price (Together does), it goes to `modelos.yaml` so the spend
  shown is the real one; otherwise the core's own table or estimate is used.
- The assistant knows which model it runs on and that the owner changes it in
  Settings › This computer. Plugins can add a stable note like this to the
  assistant's instructions through the new `systemNote` port.
- The setup page also chooses who handles voice messages: Google Gemini,
  OpenAI or nobody. When it is the same provider as the text, the same key
  serves both; otherwise it asks for a second key. The assistant knows whether
  it can hear and speak, and Settings › This computer shows it.
- OpenAI transcription and voice (`gpt-4o-mini-transcribe` and
  `gpt-4o-mini-tts`), priced like any other model. `BRAMBIT_AUDIO_PROVIDER`
  (`gemini`, `openai` or `none`) picks the service; unset, it is Gemini when
  `GEMINI_API_KEY` is there, else OpenAI.

### Changed
- With only `OPENAI_API_KEY` set, voice messages now work (before, they
  needed a Gemini key).
- "Change the AI" in Settings › This computer is now "Change the AI or the
  model", and the saved key is kept when the provider stays the same.
- Tests moved from the repository root to `tests/`, and the ones with
  Portuguese file names got English names (run them with
  `node --test tests/<file>.test.mjs`).
- On an instance without Google or Microsoft sign-in, the first access no
  longer offers to connect accounts or suggests tasks: after the person names
  the assistant, a chat opens where the assistant introduces itself, says what
  it helps with and asks three questions to get to know them, with the
  microphone pointed out when voice is set up.

### Fixed
- The `.env.example` guard, run from an app that installs Brambit as a
  package, no longer reports a line that configures the core (such as
  `BRAMBIT_DEFAULT_LANGUAGE`) as read by no code.

## [0.2.8] - 2026-10-08

### Added
- Translation catalogs (`web/locales/<tag>.json`, contract in `docs/i18n.md`):
  plugins bring their own in a `locales` field, and an instance can adjust
  wording in `BRAMBIT_LOCALES_DIR` (`<data folder>/locales` with
  `npm run brambit`).
- `npm run brambit -- start | stop | status`: one copy per data folder;
  running it again while it runs only opens the browser. The owner gets a
  "This computer" section in Settings (address, data folder, AI, version)
  with "Change the AI" and "Turn Brambit off".
- One-line install for people who don't code, no administrator needed:
  `install.ps1` on Windows (`irm ... | iex`) and `install.sh` on macOS and
  Linux (`curl ... | bash`). They bring their own Node.js (checksum pinned),
  install the `brambit` command, a shortcut that opens the browser and
  starting with the computer, and update an existing install when run again.
- `brambit open` (starts in the background if needed and opens the browser)
  and `brambit uninstall` (removes the program and shortcuts, keeps the data).
- CI runs the real installer on Windows, macOS and Linux and checks the
  installed copy (open, setup, status, stop, uninstall).
- `README.pt-BR.md`; the README is now in English.
- `AGENTS.md`: instructions for coding agents (and people) working in this
  repository, starting with: everything in the repository is in English.
- Pages take their text from the catalogs: an element marked
  `data-i18n="key"` (or `data-i18n-<attribute>`) is filled in the person's
  language, with bold, links and commands kept in place
  (`docs/i18n.md`, "Pages"). The usage, Runner and public service pages use
  it, and are now translated into English and Spanish in full. CI fails on new
  page text outside the catalogs.
- The main screen's markup (sign-in, first-time setup and the app's sections)
  takes its text from the catalogs too (`index_page.*`); names that stay the
  same in every language carry `translate="no"`. Texts built by its script
  are moving to `index_script.*` area by area: network errors, attachments,
  sign-in and password reset, connections (Google, apps, credentials, App
  Store Connect, WhatsApp, Telegram, Runner), contacts, Spaces, Skills, the
  skill library, the home greeting and date, the assistant and app lists, the
  chat list, the Files screen, the memory and assistant prompt settings, the
  webhook, identity photo and voice, the business account, the web address,
  the credits, plan, model and media cost screen, the assistant templates,
  chat, Slack, the browser extension and the sign-in, billing and connection
  notices are done.

### Changed
- Server error and status messages come from the catalogs (`server.*` in
  `web/locales`), so an instance or plugin can reword or translate them there;
  `web/textos-servidor` is gone. A plugin's `textosServidor` still works.
- The sentences of the confirmation card (what the assistant asks to do and
  what it did) come from the catalogs too (`confirm.*`), in every language
  through the same code; `web/confirm-textos.mjs` and
  `web/confirm-textos-portao.mjs` are gone. The rest of the card moved too:
  how to confirm, the address warning, pending payment and Pix notices,
  calendar and private app lines.
- The onboarding screens take their text from the catalogs too (`onboarding.*`),
  served to the page in its language by `GET /api/texts/onboarding`;
  `translateUi` in `web/public/ui-texts.mjs` is gone.
- The routines list takes its text from the catalogs too (`routines.*`, through
  `GET /api/texts/routines`), so a fourth language or a plugin can translate it.
  `cadence()` and `routineHealth()` in `web/public/routines.mjs` now receive
  those texts instead of a language.
- The instance default language is now English: it is used when nothing is
  known about the person (no saved setting, channel or browser language). To
  keep Portuguese, set `BRAMBIT_DEFAULT_LANGUAGE=pt-BR`.
- Times follow the person's time zone in more places (conversation history
  search, media list, Pix expiry, memory updates). When the person has none
  saved, the instance time zone is used: `BRAMBIT_DEFAULT_TIMEZONE`, else the
  machine's, instead of a fixed America/Sao_Paulo. To keep the old behavior on
  a machine in another zone, set `BRAMBIT_DEFAULT_TIMEZONE=America/Sao_Paulo`.
- Reports, metrics and the monthly allowance window use the instance time zone
  instead of a fixed America/Sao_Paulo, and the spend tool (`consultar_gasto`)
  counts days in the person's time zone. `currentPeriodBRT` in
  `web/periodo.mjs` is now `currentPeriod`; the old name still works.
- Renamed, so the repository stays in English: `BRAMBIT_CADASTRO=fechado` is
  now `BRAMBIT_SIGNUP=closed`, `BRAMBIT_DADOS` is `BRAMBIT_DATA_DIR`, the
  `instalador/` folder is `installer/`, and the installer's data files are
  `installation.json` and `db/`. An install set up with 0.2.7 runs the setup
  again.
- `npm run local`: the test account is `test@example.com` /
  `brambit-local-test`.
- CI jobs renamed: "Quick checks", "Boots on <system>" and "Area tests" /
  "Full suite".

### Fixed
- Labels of the main screen that stayed in Portuguese in English and Spanish
  (Accept, Decline, Install, Connect, Reconnect, Hide, Calendar, "invited
  you", vote counts, Rename, Style, Favorite, Archive, Images, Documents, the
  home date...) are translated, and a Space owner's name with `&` or
  `<` no longer shows escaped twice.
- In English and Spanish the Slack pairing instruction said `connect CODE` /
  `conectes CODE`, which Slack does not recognize; it shows `conectar CODE`,
  the command the bot reads, in every language.
- The webhook status and its Reactivate button are translated, and the call
  count has a proper singular instead of "call(s)".
- The confirmation card says what was done after removing an app file or
  secret, configuring the discovery journey or editing its note, instead of
  the generic "Action ... completed"; in English and Spanish, a routine
  delivered only in the app now says so instead of "delivered on app".
- App slot markers accept CRLF line endings: on Windows every plugin with an
  app slot failed at boot.
- Main screen in English and Spanish: sentences that came out half translated
  or with a word repeated (sign-up terms, Telegram, App Store Connect) and
  labels that stayed in Portuguese (public service, WhatsApp confirmation,
  "View invite", "Company") are now translated.

## [0.2.7] - 2026-10-07

### Added
- `npm run brambit`: Brambit on your own computer, for people who are not
  technical. The first run opens a setup page in the browser (owner, AI
  provider and its key, tested before saving and stored encrypted); the
  owner's account is created there and sign-up closes for everyone else.
  Data lives outside the program folder (`~/.brambit` or `BRAMBIT_DADOS`)
  and everything listens on 127.0.0.1 only.
- `BRAMBIT_CADASTRO=fechado`: closed sign-up without a plugin; only
  `ADMIN_EMAIL` can create an account.
- Plugin field `csp`: extra https origins a plugin's pages load (analytics,
  a conversion tag), only in script-src, img-src, connect-src and frame-src.
- `ganchosDoApp.aoCadastrar`: app hook that runs when an account is created.

### Changed
- Runs on Windows and macOS as well as Linux: Postgres over TCP on
  127.0.0.1 with a password, a portable task lock, and CI that boots, signs
  up and logs in on the three systems.
- On a local install opened in a browser on the same computer, cookies go
  without `Secure` so login sticks in Safari (WebKit drops Secure cookies on
  http://localhost). Anything that arrives over a network keeps `Secure`.

### Removed
- The core no longer loads Google Analytics or Google Ads: its CSP has no
  external origin. A deployment that wants them adds the tag and the
  origins in its own plugin.

## [0.2.6] - 2026-10-07

### Added
- `TODO.md`: open work grouped by area, with items tagged for first-time
  contributors. CONTRIBUTING points to it.

### Changed
- Tool descriptions and parameter descriptions the model reads are in
  English, like the main prompt. Quoted examples of what a person says,
  enum values and labels shown to people are unchanged, and the model still
  answers in the person's language.
- The prompts of the sub-agents that run inside a turn (research, Google,
  connectors, Nuvemshop, Canva, spreadsheet analysis and editing, coding and
  apps), the emergency-mode note and the core recovery notes are in English.
  Parsed markers (`EVIDENCIA:`, the clarification sentinel) and the fallback
  texts that reach people are unchanged.
- The prompts of background jobs are in English: memory and wiki upkeep,
  conversation summaries, agent-to-agent talks, anonymization, video
  moderation, routines, curation, e-mail search and review, onboarding and
  check-in reports. Parsed markers and JSON keys are unchanged. Conversation
  summaries are now written in the conversation's language instead of always
  in Portuguese.

## [0.2.5] - 2026-10-07

### Added
- This changelog, and a "Why it belongs in Brambit" section in the pull
  request template.

### Changed
- Core comments, docs, prompt examples and test fixtures use neutral names:
  no deployment, client, person or internal host names. Identifiers and
  values the code sends or stores (env vars, headers, paths, keys) are
  unchanged.

### Fixed
- Text the model writes in the same step as a tool that records something
  or proposes an action is delivered before the final text instead of being
  dropped. Tools opt in with `keepsStepText` (or on their `confirmationTool`);
  `criar_rotina`, `oferecer_rotina` and `memoria_anotar` do (#23).

## [0.2.4] - 2026-10-06

### Changed
- The model-facing prompt (system prompt, fixed rules and per-turn
  instructions) is in English. Replies still follow the person's language;
  tool names, parsed markers and user-facing text are unchanged (#16).
- The reply language is decided once per turn, and every text the platform
  adds to the reply (receipts, source lists, search notices, credit stops)
  uses it. Short English and Spanish requests are now recognized (#17, #18).

### Added
- WhatsApp public-facing outputs: images are uploaded to Meta as JPEG/PNG
  (other formats are converted) through the SSRF-guarded fetch; an output with
  an image waits for its delivery status before the next one is sent
  (`WA_ESPERA_ENTREGA_MS`, default 15 s); image, button and template outputs
  accept a `reserva` text sent when Meta rejects them (#19).

## [0.2.3] - 2026-10-06

### Removed
- The notice about links the checker could not confirm (403, 429, timeouts).
  Links proven dead are still removed, with their notice (#14).

## [0.2.2] - 2026-10-06

### Changed
- The unchecked-link notice names the site it refers to (#12). Superseded by
  0.2.3, which drops that notice.

## [0.2.1] - 2026-10-06

### Added
- Reply in the language the person wrote in: `idiomaEscrito` detects the
  language of the person's message (conservatively) and the per-turn reminder
  names it when it differs from the account's language (#10).

## [0.2.0] - 2026-10-06

### Added
- Public-facing service: an owner's assistant can answer people who have no
  account, for example a business's customers on WhatsApp.
  - Its own turn, isolated from the owner's data; encrypted contact phone
    numbers with a blind index (#1).
  - WhatsApp wiring, enabled per installation with `ATENDIMENTO_PUBLICO_AGENTE`
    and switched on by that assistant's owner; without it nothing changes (#2).
  - Brakes and data protection: stop/resume/erase commands from the contact,
    per-contact hourly limit, optional daily cost cap, export, erase and
    retention (#3).
  - Owner view at `/atendimento`: settings, contacts, conversations, block,
    export and erase (#4).
  - `atendimentoPublico` plugin port with `antesDoModelo` / `depoisDoModelo`
    hooks, rich outputs (text, image, link button, approved template) and
    split messages joined into one turn (#5).
  - Optional image header on the link button output (#6).
  - Plugin tools in the public turn can read and store the contact's state (#7).
- Sources by reference: the platform numbers the sources a turn used and
  builds the "Sources" list from what the model cited (#8).

### Changed
- The grounding brake is calibrated against real firings (links, coupons,
  derived prices) (#8).

## [0.1.0] - 2026-10-05

First version of the core as an installable package, split from the hosted
service built on it.

### Added
- AI assistants per person, over web, WhatsApp, Telegram, e-mail and Slack,
  with memory, connectors (Google, Microsoft, GitHub, MCP), a code sandbox,
  small hosted apps and scheduled routines.
- Model choice is the installer's: any OpenAI-compatible provider or Gemini,
  configured in `modelos.yaml`.
- Plugin ports, so a deployment adds its own billing, permissions, routes,
  tools, events and brand without changing the core; the external plugin list
  is read from `BRAMBIT_PLUGINS`.
- `npm run local`: disposable local database, test account and server.
- Guards and the test suite run from the directory they are called from, so
  an app that installs Brambit can run them on its own repo.

[Unreleased]: https://github.com/morethanrealio/brambit/compare/v0.2.11...HEAD
[0.2.11]: https://github.com/morethanrealio/brambit/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/morethanrealio/brambit/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/morethanrealio/brambit/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/morethanrealio/brambit/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/morethanrealio/brambit/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/morethanrealio/brambit/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/morethanrealio/brambit/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/morethanrealio/brambit/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/morethanrealio/brambit/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/morethanrealio/brambit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/morethanrealio/brambit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/morethanrealio/brambit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/morethanrealio/brambit/releases/tag/v0.1.0
