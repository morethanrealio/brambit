# TODO

Open work on Brambit, grouped by area. Each item says what is wrong or
missing, why it matters and where to start reading.

Want to take an item? Follow [CONTRIBUTING.md](CONTRIBUTING.md): open an issue
(or comment on the one linked here) before writing code, so two people don't
do the same work. The PR that finishes an item removes it from this file; a
PR that finds new work adds it here.

Tags:

- **good first task**: self-contained, with a clear place to start.
- **needs design**: open an issue with a proposal before writing code.
- **maintainer decision**: waiting on a decision; don't start yet.

## 1. Reply language

### 1.1 Check the language of every text before it reaches a person (needs design)

The assistant must answer in the language of the person. Today this rests on
the prompt (the language directive and the per-turn reminder in
`web/locale.mjs`), which works almost always, but an instruction is not a
guarantee. The only check on the output is `freioDeIdioma`
(`web/freio-idioma.mjs`), and it catches one case: Chinese, Japanese or
Korean characters the person didn't ask for. A reply in Portuguese to someone
who writes in English (or any mix-up between pt, en and es) is only logged
(`[idioma DERIVA]` from `logDerivaIdioma`), not stopped. The check also runs
only on the chat and routine reply (`web/server.mjs`, the single call to
`freioDeIdioma`). Agent-to-agent messages and texts written by background
jobs are not checked at all.

Goal: zero texts in the wrong language. A possible path:

1. Measure first. Run the detector (`derivaDeIdioma`, or a better one) over
   real replies, compare with the language of the turn (`idiomaDaResposta`)
   and count real drifts and false alarms: quotes, names, code, links,
   product names, a person who asks for a translation.
2. Extend the guard from ideograms to pt/en/es drift, reusing the rewrite
   path that already exists (same model, one short call without tools, at
   most two tries, then a short notice).
3. Run it on every text that goes to a person, not only the chat reply:
   agent-to-agent messages, scheduled deliveries and notifications from
   background jobs.

### 1.2 Platform texts that are always in Portuguese (good first task)

- `web/coding-task-runner.mjs:108`: when a background coding job stops, the
  message comes from `creditStopMessage` without the language, and the
  generic fallback ("A execução foi interrompida...") exists only in
  Portuguese.
- The closing phrases of the onboarding journey (`CLOSING` in
  `discovery/runtime.mts`) are in Portuguese for en and es accounts. Edit the
  `.mts` source; generated files are rebuilt by `build.mts`.

## 2. Prompts the model reads, in English

Rule: what the model reads is in English; what reaches a person stays in the
person's language; a marker that code parses changes only in the same PR as
its parser. The main prompt, the tool descriptions, the sub-agents and the
background jobs are done (see [CHANGELOG.md](CHANGELOG.md)). What is left:

- Context blocks and tool-result instructions read in the main turn (~320
  strings; `web/hosting.mjs` alone has ~85). Among them:
  `ROUTINE_REMINDER_CONFLICT` (`web/routine-delivery.mjs`), the flight answer
  contract, the checklist and shopping context, the public-service prompt,
  the Runner context (`web/runner.mjs`) and the app card in `web/hosting.mjs`.
- `process.env.NOME` / `os.environ["NOME"]` in the app-building prompts of
  `web/hosting.mjs` (good first task). Write `NAME`, then remove `NOME` from
  the `IGNORE` map in `test-support/env-example-guard.mjs`.
- The `ex:` examples in the connector tool texts of `web/server.mjs`.
- Fallback texts and retry prompts of the spreadsheet editor
  (`web/planilha-edit.mjs`). The prompt and the `PRECISO_DE_CLARIFICACAO`
  sentinel it parses change together.
- `VOICE_INPUT_NOTE` (`web/confirm.mjs`): `userSaid()` and
  `web/voice-input.mjs` match this text literally. Change all three together,
  or keep the old text as an accepted alias.
- Prompts that ask for Portuguese output instead of the person's language:
  grounded search in `core-proto/providers/gemini.mjs`, image description,
  PDF text extraction and audio transcription in `web/media.mjs`, and the
  `ORIENTACAO` lines of the grounding retry (`web/grounding-guard.mjs`).
  After translating, the output should follow the language of the turn.
- The questions sent to the intent classifier (`web/jev.mjs`). Its routing
  accuracy was measured with the Portuguese text; measure it again before
  shipping the translation.
- The system prompts of the dev scripts `discovery/report-preview.mts` and
  `discovery/live-eval.mts`. Edit the `.mts` source; generated files are
  rebuilt by `build.mts`.
- The video moderation job (`web/videomod.mjs`) asks the model for the
  `reason` in Portuguese.

Don't translate the Portuguese keyword lists and regexes that read what
people write: they parse user text, so they stay.

## 3. Bugs

- **Agent-to-agent message lost in Spanish** (good first task).
  `parseTurn` in `web/agent2agent.mjs` reads the message from the JSON keys
  `mensagem` or `message`. A model that writes the key in Spanish
  (`mensaje`) gets no message, and the whole raw JSON goes out as the text.
- **Onboarding notes empty when the label opens the text** (good first task).
  `parseOnboard` in `web/server.mjs` splits on `\n` + `PARA_LEMBRAR:` and
  `\n` + `SUGESTOES:`. When the model's text starts with the label, with no
  greeting before it (the refresh run), there is no newline to match and the
  notes and suggestions come back empty.
- **`salvar_credencial` contradicts itself.** When the key comes empty, its
  tool result (in `web/server.mjs`) tells the model to ask the person for the
  API key, while the tool description says never to ask for a key in the
  chat. Fix it together with the
  translation of that result.

## 4. Tests and code health

- Tests that fail on `main` because their fixtures still use old names:
  `busca-turno`, `curation-integration`, `routine-recovery-6624`,
  `thread-history` (good first task).
- `updateProfile` in `web/server.mjs` has no caller. Delete it.
- `web/wiki.mjs` stores the `MARCA_LINKS` heading inside saved wiki pages.
  Changing the marker needs a data migration or reading both forms.

## 5. Neutral core (maintainer decision)

- Identifiers that still carry the name of the first deployment: an env var
  prefix, HTTP headers, install paths, `localStorage` keys, the user agent
  and a font family. Renaming them breaks running installations, so it needs
  a migration plan.
- An ad tracking tag hard-coded in `web/public/index.html`.
- The default database name in `web/db.mjs`.
- Tool and parameter names are in Portuguese. Stored history and pending
  confirmations reference them by name, so a rename needs aliases or a
  migration.
