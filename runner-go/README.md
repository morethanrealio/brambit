# Runner (Go core)

Native daemon that runs on the user's machine: dials OUTBOUND to the server
(long-poll), executes commands locally and streams the output back.
Second transport behind the SAME `terminal` tool. This is the ONLY runner
distributed: the old Node version (`web/public/<slug>-runner.mjs`) left the repo and the
`/runner` page on 2026-08-26, because it was stuck on protocol 1.0 (`exec` only) and the client
silently discards an unknown frame — continuing to offer it would just leave a file
request hanging until timeout. The protocol reference is now this
`main.go` + `web/runner.mjs`.

Deterministic write confinement by the OS (not command parsing):
seatbelt on macOS, bubblewrap on Linux. Where it can't be fenced (Windows,
Linux without bwrap), restricted mode REFUSES every command (exit 126, since 2.2.0);
to use it there the owner chooses full access on purpose, via the "Liberar acesso
total nesta máquina" button in the panel or in the config. The panel only offers that button where
there is no fence: where there is one, a fenced command could find the panel's address and
promote itself, so there full access still only comes from the local config. Reading = whole system; writing = only the
authorized folders (local config `~/.<slug>-runner.json`, never widened by the
server).

## Brand

Name, site and prefixes are not in the source: they come in at build time
(`marca.go`, filled in via `-ldflags -X`). With nothing set, it's the core's:

| | default (core) | with `PRODUTO=Acme` |
|---|---|---|
| name on screen | Brambit Runner | Acme Runner |
| executable | `brambit-runner-linux` etc. | `acme-runner-linux` etc. |
| variables | `BRAMBIT_RUNNER_TOKEN`, `BRAMBIT_URL`... | `ACME_RUNNER_TOKEN`, `ACME_URL`... |
| local config | `~/.brambit-runner.json` | `~/.acme-runner.json` |
| default write folder | `~/Documents/Brambit` | `~/Documents/Acme` |

`PRODUTO` has to be the same brand name as the server's (`marca().nome`):
it's where `/runner` takes the names of the files to download and the commands
it shows. Renaming an install that already has the Runner installed changes the
local config and the variables, so the old Runners stop finding the token.

## Build (binaries served at /runner)

```sh
PRODUTO=Acme SITE=https://acme.exemplo ./build.sh
```

Builds the four executables in `web/public/runner-bin` (variables at the top of
`build.sh`). The Mac double-click app (`<PRODUTO>-Runner-Mac.zip`, with the
`.app`) doesn't come out of the script.

`-H windowsgui` on Windows is NOT optional and doesn't come from the source: it's a link flag.
Without it the .exe comes out as console subsystem (3) and opens a black terminal
window on every run. With it, it comes out as subsystem 2 (GUI), which is the
expected behavior for the double-click app. Check with `pe+24+68` in the optional header.

## Two modes (the binary is the same)

Decided in `main()` by the presence of `<SLUG>_RUNNER_TOKEN` in the environment:

- **with token in the environment** => CLI mode (`runCLI()`), the usual
  behavior, for whoever runs it in a terminal.
- **without token in the environment** => panel mode (`startPanel()`, `panel.go`): brings up
  a local HTTP server on `127.0.0.1:0`, rolls a nonce, opens the browser at
  `http://127.0.0.1:PORT/?k=<nonce>` and waits for the connection code pasted by the
  user. The token goes to `~/.<slug>-runner.json` in mode 0600. Every panel
  route requires the nonce (without it, 403). This is the path taken by the double-click on
  the `.app` and on the .exe.

The panel's source (`panel.go`, `panel_html.go`, the .exe icon)
was left out of the repo between 2026-08-21 and 2026-08-26: only the compiled binaries
were committed. Whoever rebuilt it from the repo on 2026-08-26 got an app that
fell into `runCLI()`, complained about a missing token and died on open. If
touching this, make sure the whole source goes into the commit.

Env (prefix = `SLUG` uppercased): `<SLUG>_RUNNER_TOKEN` (required only in
CLI mode), `<SLUG>_URL` (default: the build's `SITE`), `<SLUG>_RUNNER_DIR`,
`<SLUG>_RUNNER_MODE` (read-only|workspace-write|full-access),
`<SLUG>_RUNNER_WRITE_DIRS`.

PENDING (Phase D): signing/notarization + installers (.dmg/.pkg/.exe) +
pairing deep-link (Phase C). Phase B (double-click app) delivered: it's the panel mode above.
