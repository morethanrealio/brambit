# Changelog

From the version after 0.2.24 on, release notes are published with each version
on [GitHub Releases](https://github.com/morethanrealio/brambit/releases), generated
from the pull requests it carries ([docs/releasing.md](docs/releasing.md)). This
file keeps the notes of 0.2.24 and earlier and is no longer edited.

Versions are git tags; an app pins one in its `package.json` (`brambit#vX.Y.Z`)
and moves to a new one on purpose.

The public history of this repository starts at 0.2.23. The notes of earlier
versions stay below for reference, but their tags are no longer published.

## [0.2.24] - 2026-10-17

### Added
- Brambit on your own computer can be shared with your household:
  `brambit share <https address>` saves the address Tailscale Serve gives this
  computer (`BRAMBIT_SHARED_URL`, also in System settings), and the others at home
  open it on their own devices and create their account with your invite code.
  Links and invites use that address, and Settings > This computer shows it.
  `brambit share off` goes back to this computer only. See "Share it with your
  household" in the README.

### Changed
- The app's pages are on English paths, whatever the person's language:
  `/chats` (was `/inicio` and `/conversas`), `/new`, `/assistants`, `/memory`,
  `/skills-and-apps`, `/connections`, `/contacts`, `/files`, `/credits`,
  `/settings` and `/public-support` (was `/atendimento`). The login form opens
  with `/login?mode=sign-in` (was `?modo=entrar`). The old paths answer with a
  permanent redirect and the old query still opens the login form, so links
  already sent keep working; a plugin page that links to the app can move to
  the new paths when convenient.

### Fixed
- A browser extension that rewrites the Origin header no longer blocks the
  first-run setup ("Something went wrong") or the account it creates
  ("Unauthorized origin"). Both servers also accept a request when the browser
  itself says it came from the same site (Sec-Fetch-Site: same-origin, which no
  page can set), and the app server still accepts every request it accepted
  before. The Brambit window now says why the setup page refused a request.

## [0.2.23] - 2026-10-16

### Removed
- Tags before v0.2.23 are no longer published, since the repository history
  now starts at this version. An app that pins an older tag in its
  `package.json` has to move to `brambit#v0.2.23` (or later) to install again;
  an installation already running is not affected until it reinstalls.

### Added
- Public support over the web: an assistant in public mode can now answer a
  website's chat or another server, not only WhatsApp. The owner turns it on
  in /atendimento, lists the sites allowed to call it from the browser and can
  generate a key for server-to-server calls (shown once; a new key replaces
  the old). `POST /api/public/messages?agent=<id>` takes `{message, contact?}`
  and returns `{contact, text, outputs}`; `GET` with the `Brambit-Contact`
  header returns that contact's conversation only. Browser contacts are signed
  tokens issued by Brambit, so nobody reads another visitor's conversation by
  guessing. The existing public-support limits apply as on WhatsApp.
- The server key of the public web channel can be locked to the owner's
  server addresses (IPs or CIDR ranges) in /atendimento; from anywhere else
  the key is refused (`403 ip_not_allowed`). An empty list keeps today's
  behavior. How to call the channel: `docs/public-web.md`.
- Public-support plugins can send a data output (`{tipo:'data', nome, data}`)
  for pages that render their own components, such as a product card or a
  command for a widget on the page. The web channel returns it in `outputs`;
  WhatsApp sends its `reserva` text, or nothing when there is none.
- The public web channel takes page events: instead of `message`, a page can
  send `event: {type, data?}` when the person does something that is not
  typing (picks a color, opens the camera). The assistant answers it like a
  message, plugins see it in their public-support hooks, and the conversation
  returned by `GET` marks it with `event` so the page can show it its own way.
- Public support has a second hourly limit that adds up all contacts of an
  assistant (default 1000 messages, set in /atendimento). Past it, a message
  gets the "can't answer now" reply without reaching the model and is not
  recorded, so many new contacts at once can't get around the per-contact
  limit.
- Usage profiles (`BRAMBIT_PROFILE`), so an installation runs only what it
  is for: `complete` (default, everything, as before), `personal` (everything
  except public support) and `public-support` (only public support: the owner
  signs in, creates and sets up the assistant in /atendimento, follows usage
  and the installation settings; the public talks to it on WhatsApp and on the
  website; sign-up is always closed). What a profile turns off answers 404 and
  its background jobs don't start; nothing is deleted, and a change applies
  on the next start. Plugin routes keep answering when registered with
  `rotas.registrar`.
- Public support can be limited to the sites the assistant may send people
  to, listed in /atendimento (a domain also covers its subdomains). On
  WhatsApp and on the website, a button to any other site becomes plain text
  and other sites' addresses and e-mail addresses leave the answer, in any
  letter case, so a message can't talk the assistant into sending people
  elsewhere. An empty list checks nothing, as before. Templates, data outputs
  and a plugin's fixed answers are not checked.

### Changed
- Public support now has a daily spending cap by default: US$10 for an
  assistant whose owner never set one (before, no cap). Change it in
  /atendimento; clearing the field goes back to US$10.
- Public support stays off, on WhatsApp and on the website, while anyone can
  create an account on the installation (`BRAMBIT_SIGNUP` empty): the address
  handed to the public would also hand out accounts paid by the owner.
  /atendimento says so; set `BRAMBIT_SIGNUP=closed` to turn it back on. When a
  plugin decides sign-up, the plugin decides this too.
- The installer for your own computer (`npm run brambit`) writes
  `BRAMBIT_PROFILE=personal`, since public support needs a public address.
  Change it in /admin/settings.
- WhatsApp log lines show only the last 4 digits of a phone number (template
  resend and deliveries refused by Meta).
- Public support: the instructions written in /atendimento no longer get
  dropped when a plugin brings its own for the turn (`antesDoModelo`). The
  plugin's come first and the owner's are added after them, so the box now
  reads "Extra instructions".

### Fixed
- System settings (/admin/settings): each section showed
  "[object HTMLDivElement]" instead of its settings, so nothing could be read
  or edited on the screen. The settings now show up again.
- A public-support turn that failed (for example, the database dropping out
  mid-turn) could stop the whole server. Now only that message gets the error.

## [0.2.22] - 2026-10-15

### Added
- The mobile app can connect Google and the other providers (GitHub, Slack,
  Microsoft...) without a browser session: `POST /api/mobile/connect` gives a
  single-use start link, the provider comes back to the app through
  `brambs://connect`, and only the session that started the flow can finish it
  (`POST /api/mobile/connect/finish`). Same scopes and redirect URIs as the site.
- Google login from new app builds (`/api/auth/google/start?mobile=2`) goes
  straight back to the app with `brambs://auth`. Older builds (`mobile=1`) keep
  the page with "Back to the app" and "Connect Google here".

- Slack: a team assistant answers the workspace's full members in the channels
  it is in, with one conversation per channel and none of the owner's private
  context. Its direct messages stay the owner's; anyone else is told to mention
  it in a channel. Replies go out under the assistant's name when the Slack app
  has the `chat:write.customize` scope (otherwise under the app's name).
- A team assistant reaches the owner's Google Drive only inside its own folder
  (tool group `drive`).

### Changed
- Sign-up from app builds that have their own check-your-e-mail screen (they
  send `confirmEmailScreen: true`) gets the same 200 `{confirmEmail, email, sent}`
  as the site. Older builds keep the 403 that carries the instructions.
- Open work moved from `TODO.md` to GitHub issues, with the labels
  `good first issue`, `needs design`, `maintainer decision` and `translation`.
  `TODO.md` now points to them.
- Login cookies are `__Host-` cookies (`__Host-sid` and the OAuth flow cookies),
  except on a local install over loopback. Everyone signed in on the web logs in
  once after upgrading; the mobile app is not affected.
- With e-mail configured, a sign-up with a password becomes an account only when
  the link in the confirmation e-mail is confirmed (link valid 24 h, request
  7 days). Without e-mail, sign-up works as before.
- The password-reset e-mail and the `/api/forgot` reply use the account's
  language (pt/en/es).
- Inbound e-mail whose sender cannot be authenticated is ignored by default.
  Set `EMAIL_STRICT_AUTH=0` to keep the old behavior.
- Inbound e-mails that were answered are kept until the account is deleted;
  skipped or failed ones are deleted after 7 days.
- Sandbox host: SSH commands and key generation run in a second per-user
  container (`sbxssh_<id>`) through runnerd's new `/ssh` endpoint, so the private
  key never reaches the container where the model's code runs. Update
  `ops/sandbox-host/runner.mjs` and `runnerd.mjs` on the sandbox host and restart
  runnerd BEFORE the server: an older runnerd answers 404 on `/ssh`. Each SSH
  host is trusted again once.
- Apps host: containers are named `brambs-<label>.<system>` (two tenants could
  share the old `brambs-<label>-<system>`); `ops/apps-host/deploy.sh` renames
  the running ones in place. The router turns the cookies an app sets into
  host-only `__Host-` cookies, so one app can no longer plant a cookie for
  another; users of an app with a login cookie log in once.
- Public apps: the library and copies read a separate anonymized copy of the
  code, refreshed on every publish and rollback. When the code cannot be
  checked, the app stays out of the library. After upgrading, public apps leave
  the library until the boot check finishes.

### Fixed
- Links in replies: a link is opened to check it only when it appeared, character
  for character, in what the system received this turn or is on the
  deployment's own hosts, and then through a pinned fetch with no redirects.
  Before, every address the model wrote was fetched, so an injected link could
  leak data with no click and reach internal hosts. A composed link makes the
  turn run once more asking for the search; what is still composed is removed
  with its sentence. Background coding jobs get the same check.
- Names chosen by other people (contact requests, decisions between assistants)
  enter the prompt as one cleaned line of at most 60 characters, under a header
  that says it is data.
- A Slack channel bound to one account can no longer be taken over with another
  account's connection code, and a personal assistant bound to a channel answers
  only its owner.
- Connect flows: the OAuth state carries who started the flow, and the callback
  saves the token only for that user. An open tab whose session is gone goes to
  the login page.
- Coding tools: paths that start with "-" are no longer read as options by the
  file tools, and host or user values shaped like ssh options are refused.
  `git_push` sends the GitHub token only to https://github.com, with hooks and
  signed push off.
- A removed Google account no longer comes back after a restart.

## [0.2.21] - 2026-10-14

### Fixed
- Apps host: `ctl.py` (root) no longer follows symlinks or opens FIFOs left by an
  app in its own folder, so an app can no longer make a publish, rollback,
  smoke test or inventory write or read files outside its folder. Git versioning
  works on a private copy of the code, and the inventory counts SQLite rows on a
  private copy of the database. Symlinks and sparse files inside an app are not
  versioned, and a publish is not versioned when the host would have less than
  2 GiB free. Update the apps host with `ops/apps-host/deploy.sh`.

## [0.2.20] - 2026-10-13

### Changed
- The receipt for a routine edit is shorter: "Routine "X" updated." plus when it
  runs and where it delivers. Gone are "in place (the old version kept running
  normally until now)", the list of internal field names that changed, the
  repeated title and the time zone ID (shown only when the time zone itself
  changed). A paused routine no longer gets a "runs every..." line.

## [0.2.19] - 2026-10-13

### Fixed
- A send accepted by the service is quiet again only when the reply names the
  right person: if the model credits it to another name ("enviei pra Bia" when it
  went to julia@), the receipt with the real address and subject replaces that
  sentence, as it did before 0.2.18.

## [0.2.18] - 2026-10-13

### Changed
- Replies carry less technical noise. A memory save or a complete routine run no
  longer adds a receipt line, and neither does a send accepted by the service
  (unless the model names another address); the model confirms them in its own
  words. The reminder receipt reads "Lembrete agendado. Destino: … Horário: …". Platform
  notices (incomplete search, consulted emails) that the model copied from earlier
  replies are removed, so they only show when this turn observed them. A copy of
  the confirmation card written by the model is removed, so the card appears once.
  The prompt also forbids tool names, parameter names and internal IDs in replies.

## [0.2.17] - 2026-10-13

### Fixed
- A routine with an email search could not open files, spreadsheets or the
  calendar: every tool except memory was removed from its run, so a routine
  that crosses the emails with a spreadsheet failed on every run. Now only
  the mailbox search tools are removed (the platform already did that
  search), and an empty email list no longer cuts the rest of the routine.

## [0.2.16] - 2026-10-12

### Added
- The server can read its configuration file itself and apply changes while
  it runs. Point `BRAMBIT_CONFIG_FILE` at the file (the same one systemd loads
  with `EnvironmentFile=`); edits to it reach the server within a couple of
  seconds, and secrets can be stored in it encrypted with the vault key
  (`KEY=vault:v1:...`). `npm run local` turns this on for the root `.env`.
  Most settings are still read once at start.
- System settings screen at `/admin/settings`, for the admin only (the
  `ADMIN_EMAIL` account). It edits the config file, section by section as in
  `.env.example`: shows where each value comes from, saves and clears it,
  never shows a secret back and stores new secrets encrypted. Test buttons
  check a model key, mail server, WhatsApp number, Slack bot, search key or
  sandbox without sending anything. Settings that only apply on the next
  start are marked; clearing the DeepSeek key or handing the admin role over
  asks for confirmation first.

### Changed
- Settings that were read once at start now apply from the config file
  without a restart: provider URLs (`TOGETHER_URL`, `DEEPINFRA_URL`,
  `OPENAI_URL`, `NEMOTRON_*`), web search (`TAVILY_URL`,
  `TAVILY_EXTRACT_URL`, `SEARCH_FALLBACK_MODEL`, `MAX_SEARCHES_PER_TURN`),
  sandbox, dev exec and apps host connection, `EGRESS_MODE`,
  `EMAIL_TRUSTED_AUTHSERV`, memory and coding compaction limits, agent to
  agent limits, LinkedIn and Canva scopes, the mobile app release and a few
  timeouts.
- Model choice (`PRIMARY_TEXT_MODEL`, `PRIMARY_MODEL`, `FALLBACK_*`,
  `CHEAP_MODEL`, `ROBUSTO_PROVIDER`, `KIMI_*`, `DEEPSEEK_MODEL`,
  `DEEPSEEK_PROVIDER`, `CODE_DEFER`), `modelos.yaml` (and
  `MODELOS_ARQUIVO`) and the sign-up rules (`BRAMBIT_SIGNUP`, `ADMIN_EMAIL`)
  now apply without a restart too. A `modelos.yaml` edit that no longer reads
  keeps the last good file and logs why; at start a bad file still stops the
  server, as before.
- The email and WhatsApp channels follow the config file: they start when
  their settings are added, stop when they are removed and restart when
  pointed at another inbox or number, without a restart. Changes settle for a
  few seconds first, so an edit saved in two steps does not switch a channel
  off and on. Started this way, email only answers mail that arrives from then
  on (older unread mail is left alone). The WhatsApp timing settings
  (`WA_DEBOUNCE_MS`, `WA_MEDIA_HOLD_MS`, `WA_INTERJECT`,
  `WA_TURN_HEARTBEAT_MS`, `WA_PUBLICO_JUNTAR_*`) and `EMAIL_POLL_MS` apply
  without a restart too.
- `CALENDAR_WATCH`, `S3_INSTANCE_ROLE`, `DEEPSEEK_FLASH_ENABLED` and
  `DEEPSEEK_API_KEY` follow the config file as well: the calendar change
  notice, the instance role credential refresh and the DeepSeek V4.1 Flash
  option start and stop without a restart, and a new DeepSeek key is checked
  again. `TELEGRAM_TURN_HEARTBEAT_MS` is read on every turn.
- The installer keeps its settings in `~/.brambit/brambit.env`, the same file
  the System settings screen edits (keys encrypted with the vault), and the
  server follows it while it runs. An existing installation moves its owner,
  AI key and audio choice there by itself on the next start;
  `installation.json` keeps only the port. The first-run page asks only for
  your account and the AI; voice messages and the rest are set later in
  Settings > This computer > System settings. Changing the AI or the model is
  now a page of the app and no longer turns the assistant off for a moment;
  the keys of providers used before stay saved, so going back to one does not
  ask for its key again.

### Fixed
- A person whose calendar was not checked for over an hour (the notice was
  off, or the server was down) no longer gets notices for everything that
  changed meanwhile: that pass becomes the new baseline.

### Fixed
- Replies no longer lose true sentences to the "done without proof" check. It
  used to remove any sentence with a word like "sent", "saved" or "noted",
  including email and agenda summaries ("3 messages sent by the school"),
  denials ("I did not send any reminder"), questions, conditions and what a
  tool had just reported. Now only a claim of the assistant's own completed
  action without a receipt is removed, and a record claim that names the
  wrong place ("noted on WhatsApp") is replaced by the real reminder or
  memory receipt of the turn.
- A routine that searches the email before the model runs no longer gets the
  notice "I did not consult any tool in this turn": the search the platform ran
  (and the native web search) counts as a fresh check, like a tool call. The
  rule also stopped moving that notice to the end of the reply when nothing
  else changed.
- The email coverage check no longer rewrites the platform's own notices. An
  agenda notice ("Google Calendar did not return the full query") was being
  swapped for a sentence about emails, a "do not treat this as exhaustive"
  caveat was read as a claim of a full search, and routines got a second,
  reworded copy of the coverage notice. Only a claim of a complete email
  search is replaced now, and an existing notice for the account is updated
  in place instead of repeated.

## [0.2.15] - 2026-10-11

### Fixed
- The assistant no longer claims abilities it does not have in the turn. A new
  prompt rule ties "I can do it" to the tools actually available: without a
  tool for it, it says up front that it cannot (video, calls, SMS, bookings,
  social posting, messaging other people, Slack delivery) and offers only
  what exists. It also stops describing app screens or steps it never saw,
  offers email to third parties only when sending is on, and the credential
  vault label and the Slack option of reminders no longer suggest something
  that is not connected or not available.

## [0.2.14] - 2026-10-11

### Fixed
- Connecting Google from the mobile app works again. App versions up to 1.0
  (build 22) open the sign-in page in the browser for "Connect Google", so the
  return to the app went nowhere and Gmail, Calendar and Drive were never
  connected. After signing in with Google from the app, the browser now shows a
  page with "Back to the app" and a button that finishes the Google connection
  right there, on the account it names.

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
  `criar_rotina`, `oferecer_rotina` and `memoria_anotar` do.

## [0.2.4] - 2026-10-06

### Changed
- The model-facing prompt (system prompt, fixed rules and per-turn
  instructions) is in English. Replies still follow the person's language;
  tool names, parsed markers and user-facing text are unchanged.
- The reply language is decided once per turn, and every text the platform
  adds to the reply (receipts, source lists, search notices, credit stops)
  uses it. Short English and Spanish requests are now recognized.

### Added
- WhatsApp public-facing outputs: images are uploaded to Meta as JPEG/PNG
  (other formats are converted) through the SSRF-guarded fetch; an output with
  an image waits for its delivery status before the next one is sent
  (`WA_ESPERA_ENTREGA_MS`, default 15 s); image, button and template outputs
  accept a `reserva` text sent when Meta rejects them.

## [0.2.3] - 2026-10-06

### Removed
- The notice about links the checker could not confirm (403, 429, timeouts).
  Links proven dead are still removed, with their notice.

## [0.2.2] - 2026-10-06

### Changed
- The unchecked-link notice names the site it refers to. Superseded by
  0.2.3, which drops that notice.

## [0.2.1] - 2026-10-06

### Added
- Reply in the language the person wrote in: `idiomaEscrito` detects the
  language of the person's message (conservatively) and the per-turn reminder
  names it when it differs from the account's language.

## [0.2.0] - 2026-10-06

### Added
- Public-facing service: an owner's assistant can answer people who have no
  account, for example a business's customers on WhatsApp.
  - Its own turn, isolated from the owner's data; encrypted contact phone
    numbers with a blind index.
  - WhatsApp wiring, enabled per installation with `ATENDIMENTO_PUBLICO_AGENTE`
    and switched on by that assistant's owner; without it nothing changes.
  - Brakes and data protection: stop/resume/erase commands from the contact,
    per-contact hourly limit, optional daily cost cap, export, erase and
    retention.
  - Owner view at `/atendimento`: settings, contacts, conversations, block,
    export and erase.
  - `atendimentoPublico` plugin port with `antesDoModelo` / `depoisDoModelo`
    hooks, rich outputs (text, image, link button, approved template) and
    split messages joined into one turn.
  - Optional image header on the link button output.
  - Plugin tools in the public turn can read and store the contact's state.
- Sources by reference: the platform numbers the sources a turn used and
  builds the "Sources" list from what the model cited.

### Changed
- The grounding brake is calibrated against real firings (links, coupons,
  derived prices).

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

[0.2.23]: https://github.com/morethanrealio/brambit/releases/tag/v0.2.23
