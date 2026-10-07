# Changelog

Notable changes to Brambit, newest first. Versions are git tags; an app pins
one in its `package.json` (`brambit#vX.Y.Z`) and moves to a new one on purpose.
Every entry is something any installation can use: features that serve a
single deployment or client live in that deployment's plugins, not here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Changes merged since the last tag go under "Unreleased".

## [Unreleased]

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

[Unreleased]: https://github.com/morethanrealio/Brambit/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/morethanrealio/Brambit/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/morethanrealio/Brambit/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/morethanrealio/Brambit/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/morethanrealio/Brambit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/morethanrealio/Brambit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/morethanrealio/Brambit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/morethanrealio/Brambit/releases/tag/v0.1.0
