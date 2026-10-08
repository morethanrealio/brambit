# Contributing

Thanks for your interest in Brambit. This guide walks a contribution from idea to
merge.

## Before you start

- *License:* the project is AGPL-3.0 ([LICENSE](LICENSE)). Your contribution is
  released under that license.
- *CLA:* on your first pull request you accept the [Contributor License
  Agreement](CLA.md). PRs without it are not merged.
- *Conduct:* the [code of conduct](CODE_OF_CONDUCT.md) applies.
- *Vulnerabilities:* do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Run it on your machine

The steps are in the [README](README.md#quick-start): `npm ci`, copy
`.env.example` and `modelos.example.yaml`, add the key for your LLM provider and run
`npm run local`. You don't need any project credential or access to production.

## Workflow

Looking for a place to start? [TODO.md](TODO.md) lists open work by area, with the
items that make a good first contribution marked.

1. For anything bigger than a small fix, open an issue first describing the problem
   and your proposal, so nobody spends time on something that won't be merged.
2. Want to take an issue? Comment on it and a maintainer will assign it to you. The
   reservation lasts 7 days, or the deadline set by the issue's label
   (`deadline: 1 day`, `deadline: 3 days`, `deadline: 30 days`). A comment from you
   on the issue renews it, and it doesn't expire while you have an open PR linked to
   the issue. Once it expires with no news, a bot removes the assignment and the
   issue is free for someone else.
3. Create a branch from `main` and open the PR against it.
4. Run the tests for the area you changed (`node --test tests/<file>.test.mjs` or the matching
   `npm run <area>:test` in `package.json`). CI runs the quick checks on every PR.
5. A maintainer of the area reviews it (see [MAINTAINERS.md](MAINTAINERS.md) and
   `.github/CODEOWNERS`).

## What a good PR has

- One subject per PR, describing the problem, what changed and how you tested it.
- A test when the change could break without anyone noticing. A test that only
  restates the code doesn't help.
- No secrets, keys, real user data, IPs or internal hosts, in code or in tests. CI
  blocks secrets (gitleaks) and unsafe workflows (zizmor).
- User-facing text in Portuguese, English and Spanish, following
  [`docs/i18n.md`](docs/i18n.md).

## Sensitive areas

Changes to login, account isolation, billing and credits, code execution, database
schema or CI need a review from the area's maintainer *and* from security. Expect a
longer review for these.
