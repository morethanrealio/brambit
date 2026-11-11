# Instructions for agents

Read this before changing anything in this repository. It applies to coding
agents (Claude Code, Codex, Cursor...) and to people alike; `CONTRIBUTING.md`
has the contribution workflow.

## Language: always English

ALWAYS use English for everything you write in this repository: comments, code,
identifiers (functions, variables, files, folders, environment variables, routes,
JSON keys), log lines, error codes, tests, commit messages, branch names, pull
requests, issues, `TODO.md`, docs and release notes.

The only exceptions:

- Text the user reads in the product, which is translated into Portuguese,
  English and Spanish. How that text is written, keyed and translated is in
  [`docs/i18n.md`](docs/i18n.md); read it before adding or changing any of it.
- `README.pt-BR.md` and `CLA.md`, which exist in Portuguese on purpose.

Part of the core still has Portuguese names from before the project went open
(`nome`, `portas`, `ligar`, `createPermissoesSimples`...). Use
them as they are; do not rename them in passing. Renaming them is its own pull
request.

## Core and plugins

Brambit is a generic engine. Anything that only serves one deployment (a brand,
a client, billing rules, analytics) goes in a plugin, not in the core: see
"Plugins" in the README and the format in `web/plugins.mjs`. The core asks the
deployment through *ports* and has a default for each one, so it runs with no
plugin at all. Optional parts that ship with Brambit are *extensions*: each lives
in `web/extensions/<name>/`, is a plugin object registered in
`web/extensions.mjs`, and an installation turns it on or off with
`BRAMBIT_EXTENSIONS` (the usage profile sets the default). Public support is
the first one: its owner screen is also open to members of a client area
(`client-areas.mjs`, off unless `BRAMBIT_CLIENT_AREAS=on`), so every route in `public-support-owner.mjs` resolves the
assistant or contact through `agentAccess()` or `contatoDoPedido()` and calls the
store with the owner's id, and a route that opens, exports, deletes or changes
something records it in the access log (`client-area-activity.mjs`, read only by the owner; a member opening the panel is logged once per sign-in, from `session_started_at` on the user). The owner can invite an email with no account: that
creates a *panel account*, which `web/account-scope.mjs` holds to the routes the
extension registers (owner pages redirect to `/public-support`, any other API is
404); a new extension route a panel member needs must be added to
`panelScope()`. Its metrics come from `public_support_events`: a plugin records with
`ctx.track(kind, ref)` and returns cards from the `metricCards` hook (`{label, value, detail?, top?}`, a funnel
`{label, steps}` or a ranking table `{label, detail?, columns, rows}`, in the `language` it gets; `top: true` puts a card in the dashboard's first row; `clicks: true` marks a per-button click card and hides the page's total of clicks); a `metricHide` hook names volume boxes to leave out for an assistant (only from `METRIC_HIDEABLE`, now `messages`); a count or funnel step may take a list of kinds and refs, and `events.top(step)` gives the step's most frequent refs; with `contactId` (`?contact=` on the metrics route) the cards are one conversation's, shown under it. A plugin's `contactProfiles` hook turns each contact's notes into profile fields (`{label, value}`, at most `PROFILE_FIELDS_MAX`) shown in the contact list and above the conversation (a value may be a list); the raw notes never leave the server. The list filters by one field's value (`?field=&value=`, options from `PROFILES_PATH`) and an owner or admin downloads it as a spreadsheet (`PROFILES_CSV_PATH`, logged); both go through at most `PROFILE_SCAN_MAX` newest contacts. Each client area may have a look: a theme is a `themes/<id>.css` file in any site folder (a plugin ships its own through `publico`) that overrides the `:root` variables of `public-support.html`; the owner picks it in the Areas section and the page loads it for the assistant's area (`client-area-themes.mjs`). Themes must stay same-origin (CSP), fonts included. A `contactNames` hook gives a contact a name from its notes (at most `CONTACT_NAME_MAX` chars), shown instead of the channel address, in the spreadsheet, and as the `?named=1` filter. Link buttons are measured through `/go` (`measureLinks`); on the
web the button keeps its real `url` and the measured one goes in `clickUrl`, because the chat picks the button's
style and in-chat modal by the url's domain. A store whose phone app claims every link on its domain (universal links) opens its own app on a 302 from `/go`; list that host in `BRAMBIT_CLICK_IN_BROWSER` and `/go` leaves by script instead, so the page stays in the browser. Extension tests stay in `tests/`. `test-support/core-guard.mjs` fails CI if the core imports or
cites a cloud file listed in `cloud.txt`.

## Library spreadsheets

A spreadsheet in the user's library is a family of versions; the current one is
the newest. The family is `familyKey` in `web/sheet-edit.mjs`: by name
(`baseFamily`) for files this code wrote (generated, edited, synced, or archived
with a stamp), but an upload, attachment or runner file stands alone (by id), so
a "fatura.xlsx" sent every month is not one spreadsheet with versions. An older
version is read with `analisar_planilha versao_id` (`openVersionForAnalysis` in
`web/sheet-library.mjs`), which never syncs it nor keeps it loaded. Uploads whose
bytes are not a zip (`opensAsSheet`) are left out of the automatic choices.
`analisar_planilha arquivo_id` analyzes the current version of that id's
spreadsheet (`openIdForAnalysis`); without a library file it analyzes only the
copies loaded in this conversation (`analysisCopies`), and with none loaded it
opens the library's only spreadsheet or asks which. An id that is not found lists
the files whose id starts or ends the same way (`idNotFound` in
`web/media-list.mjs`, also in `ler_arquivo`, `listar_midia versoes_de` and
`editar_planilha`): models copy long ids wrong, so none is opened on a guess. `ler_arquivo` with neither id nor name opens a
file only when the library has a single document (`onlyDocument` in
`web/media-list.mjs`); otherwise it asks. `editar_planilha` with neither id nor
name edits the one spreadsheet loaded in this conversation (`editTarget` in
`web/sheet-library.mjs`), and asks when several are loaded or, with none loaded,
the library has several; it never just takes the newest. A loaded copy from
outside the library (link, Drive, OneDrive, e-mail) has no `assetId` and is saved
in the library (source `link`) on its first edit, also when it is named with
`nome` (the library is searched first).

The loaded registry (`web/sheet.mjs`) is per user, in memory, 6h; each copy
records the conversation it was loaded in (`withSheetThread`, set for the whole
turn in `runConversationTurn`), so one a routine or another chat loaded is never
taken for "the spreadsheet" without a name. `safeName`
cuts long names at 80 characters keeping the extension (openpyxl refuses a path
without one). Before an analysis, a loaded copy that is no longer its family's
current version is reloaded (`refreshLoaded`); an edit that fails puts the
original bytes back in the sandbox and one that is saved relabels the sandbox
copy with the new version's id, so the sandbox never keeps a rejected edit. The
editor and the analyst have the whole sandbox, so a loaded copy the editor was not
asked to change, or any one the analyst changes, is written back as it was
(`keepLoadedCopies` in `web/sheet.mjs`). An edit that comes out with rows repeated
cell by cell, or one that shrinks a lot, is redone unless the editor declares it
was asked (`detectarProblema` in `web/sheet-edit.mjs`).

A family may be linked to a Google Sheets file (`web/sheet-google.mjs`, table from
`migrations/2026-11-09-sheet-google-links.sql`), found by family or by the id of
any of its versions, so a rename keeps the link. `sheetSync.sync`
(`web/sheet-sync.mjs`) runs before every read, analysis and edit and after every
change, so a new path that reads or writes a library spreadsheet goes through it.
A copy loaded in the sandbox is matched to the library by `assetId`, never by its
sandbox file name. Changes on both sides are merged by `web/sheet-merge.mjs` in
the sandbox, columns matched before rows; a cell changed on both sides keeps the
Google Sheets value, and when the last version in common is gone Google Sheets
wins and the local one stays as an older version. An `.xlsm` (macros) is never
linked nor synced. The merge's real test needs a local Python with openpyxl
(`SHEET_PY`) and is skipped without one.

## Checks CI runs on every pull request

- `web/server.mjs` and `web/db.mjs` may only shrink
  (`test-support/growth-guard.mjs`): new code goes in its own module and enters
  those two files at most as an import or a registration.
- No new test that reads the production source as text
  (`test-support/fragile-guard.mjs`): import the module instead.
- Every `BRAMBIT_*` environment variable the code reads is documented in
  `.env.example` (`test-support/env-example-guard.mjs`).
- Secrets (gitleaks) and unsafe workflows (zizmor). Never commit keys, real user
  data, IPs or internal hosts, not even in tests.
- The core boots on Windows, macOS and Linux (`node dev/local.mjs --check`),
  the launcher works end to end (`node installer/e2e.mjs`) and the real installer
  (`install.ps1` / `install.sh`) installs a copy that opens, sets up, stops and
  uninstalls (`node installer/install-check.mjs`).
- The version in `install.sh` (`BRAMBIT_VERSION`) and `install.ps1`
  (`$brambitVersion`) equals the one in `package.json`: bump all three together
  when releasing, since the scripts download the tag they name.

## Tests

Tests live in `tests/`. Only the TypeScript areas (`deepseek/`, `discovery/`,
`onboarding/`) keep their `.test.mts` next to the code they compile with, and
`ops/` keeps the tests and probes of its own scripts. Run only the tests for the
area you changed: `node --test tests/<file>.test.mjs` or the matching
`npm run <area>:test` in `package.json`. The full `npm test` takes several
minutes; run it only when asked. Add a test only when it catches a plausible
change that nothing else (CI, boot, normal use) would catch.

## Pull requests and releases

Don't edit `CHANGELOG.md`: release notes are generated from pull request titles
and labels when a version is published ([`docs/releasing.md`](docs/releasing.md)).
Write the pull request title as one plain sentence about what changes for whoever
runs Brambit. When an installation has to do something after upgrading (a renamed
setting or command, a reinstall), say what in the pull request description; the
`breaking change` label puts it at the top of the notes.
