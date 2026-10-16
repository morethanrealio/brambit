# Governance

Brambit is maintained by STEM Tecnologia e Desenvolvimento de Software LTDA, which
also runs Brambs, a hosted service built on it, at brambs.com.br.

## Roles

- *Contributor:* anyone who opens an issue or PR.
- *Maintainer:* reviews and merges in their area. Listed in [MAINTAINERS.md](MAINTAINERS.md).
- *Project lead:* decides the roadmap, the license and who is a maintainer, and
  breaks ties when maintainers don't agree.

## How decisions are made

- Regular change: one maintainer of the area approves.
- Sensitive area (login, account isolation, billing, code execution, database, CI):
  the area's maintainer *and* security.
- Change of direction (architecture, license, large dependency): an issue open for
  discussion before any PR; the project lead decides.

## Open core and hosted service

This repository is the core: everything someone needs to run the assistant with
their own LLM key. Running the brambs.com.br service (plans, billing, user
communication, business metrics) lives outside it and plugs in through extension
points. Fixes and features of general interest land here first.

## Trademark

The code is AGPL-3.0; the names "Brambit" and "Brambs", the logos and the mascots
are not. A modified version may say it is based on Brambit, but may not present
itself as Brambit or as Brambs.

## Becoming a maintainer

People who contribute regularly and well in an area may be invited. The project lead
decides, after hearing the current maintainers.
