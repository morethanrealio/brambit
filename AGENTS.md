# Instructions for agents

Read this before changing anything in this repository. It applies to coding
agents (Claude Code, Codex, Cursor...) and to people alike; `CONTRIBUTING.md`
has the contribution workflow.

## Language: always English

ALWAYS use English for everything you write in this repository: comments, code,
identifiers (functions, variables, files, folders, environment variables, routes,
JSON keys), log lines, error codes, tests, commit messages, branch names, pull
requests, issues, `TODO.md`, docs and `CHANGELOG.md`.

The only exceptions:

- Text the user reads in the product, which is translated into Portuguese,
  English and Spanish. Some catalogs are keyed by the Portuguese source text
  (`site-textos`, the message catalogs); keep the key and add the translations.
- `README.pt-BR.md` and `CLA.md`, which exist in Portuguese on purpose.

Part of the core still has Portuguese names from before the project went open
(`nome`, `portas`, `ligar`, `modelos.yaml`, `createPermissoesSimples`...). Use
them as they are; do not rename them in passing. Renaming them is its own pull
request.

## Core and plugins

Brambit is a generic engine. Anything that only serves one deployment (a brand,
a client, billing rules, analytics) goes in a plugin, not in the core: see
"Plugins" in the README and the format in `web/plugins.mjs`. The core asks the
deployment through *ports* and has a default for each one, so it runs with no
plugin at all. `test-support/nucleo-guard.mjs` fails CI if the core imports or
cites a cloud file listed in `nuvem.txt`.

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
- The core boots on Windows, macOS and Linux (`node dev/local.mjs --check`) and
  the installer works end to end (`node installer/e2e.mjs`).

## Tests

Run only the tests for the area you changed: `node --test file.test.mjs` or the
matching `npm run <area>:test` in `package.json`. The full `npm test` takes
several minutes; run it only when asked. Add a test only when it catches a
plausible change that nothing else (CI, boot, normal use) would catch.

## Changelog

Every user-visible change gets a line under `## [Unreleased]` in
`CHANGELOG.md` (Added, Changed, Fixed, Removed). Renamed settings or commands
go under Changed, saying what the person has to do.
