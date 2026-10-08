# Code sandbox (runnerd)

A separate service where the assistant runs user code (python, shell, node,
scraping, assembling files). The harness talks to it over HTTP when `.env`
has `SANDBOX_URL` and `SANDBOX_TOKEN` (client in `web/sandbox.mjs`); without
both, the code tools disappear and the rest works normally.

User code is arbitrary code. That's why the sandbox NEVER runs on the
harness's production machine, and isolation doesn't depend on Docker alone.

## Pieces

| File | What it is |
| --- | --- |
| `Dockerfile` | `brambs-sandbox` image (debian-slim, python, node 20, data/scraping libs), non-root user |
| `runner.mjs` | one container per user (`sbx_<id>`) with its own volume (`sbxvol_<id>`); commands via `docker exec` |
| `runnerd.mjs` | thin HTTP layer in front of the runner, Bearer `RUNNER_TOKEN` (without a token, it won't start) |
| `local.sh` | local mode: everything at once on your machine, for use with `npm run local` |
| `firewall-box.sh` | firewall for the dedicated machine (what runs in production) |
| `systemd/` | services for the dedicated machine (firewall and runnerd) |
| `daemon.json` | Docker DNS (the firewall only allows DNS to 8.8.8.8 and 1.1.1.1) |
| `runnerd.env.example` | runnerd variables |

Endpoints (POST with JSON, except `/health`): `/shell`, `/write`, `/read`,
`/readfile` (raw bytes), `/stop`, `GET /health`. Details at the top of
`runnerd.mjs`.

## Isolation

In the container (flags in `runner.mjs`): non-root user, `--cap-drop ALL`,
`no-new-privileges`, read-only rootfs (only `/workspace` and `/tmp` are
writable), memory, CPU and process limits, per-command timeout. The Docker
socket is never mounted in the container.

On the machine (firewall, because Docker alone isn't enough): the sandbox
network (`brambs-sbx`, 10.200.0.0/16) can reach the internet, but not cloud
metadata (169.254/16) nor private networks (10/8, 172.16/12, 192.168/16).
This stops the user's code from touching the database, other servers, or the
instance's credentials.

## Local mode (Linux with Docker)

```bash
ops/sandbox-host/local.sh
```

Builds the image, creates the network, turns on the firewall (asks for
`sudo`), checks DNS and proves the sandbox can't reach your machine, generates
a token at `.local/sandbox.env` and starts runnerd on `127.0.0.1:9000` in
that terminal. It prints the two lines to paste into `.env`; then restart
`npm run local`.

In local mode the firewall uses its own chains (`BRAMBS-SBX` and
`BRAMBS-SBX-IN`) and doesn't remove any rule that already exists on your
machine. Besides the private networks, it also blocks the sandbox from
reaching your own machine (otherwise it would be able to reach runnerd and
any service listening there). The rules disappear on reboot: run the script
again.

Outside Linux (Docker Desktop on macOS or Windows) Docker runs inside a VM
and the script has no way to block the network: the sandbox's code can reach
your local network. The script refuses to proceed unless you run it with
`SANDBOX_SEM_FIREWALL=1`; only do this with your own code.

## Dedicated machine (production)

A Linux machine dedicated to this, on the same private network as the
harness, with Docker and Node 18 or newer (tested on AL2023, t3.small).

1. Copy this folder to `/home/ec2-user/sandbox` and build it:
   `docker build -t brambs-sandbox:latest /home/ec2-user/sandbox`.
2. Network: `docker network create --subnet 10.200.0.0/16 brambs-sbx`.
3. DNS: put `daemon.json` at `/etc/docker/daemon.json` and restart Docker.
4. Firewall: put `firewall-box.sh` at `/usr/local/bin/brambs-sbx-setup.sh`
   and `systemd/brambs-sbx-fw.service` at `/etc/systemd/system/`. This script
   RESETS the `DOCKER-USER` chain on every run; it's built for a machine that
   only serves the sandbox. Don't use it on a machine with other rules there.
5. runnerd: turn `runnerd.env.example` into `/etc/brambs-runnerd.env`
   (`chmod 600`, new long token) and put
   `systemd/brambs-runnerd.service` at `/etc/systemd/system/`. Then
   `systemctl daemon-reload` and
   `systemctl enable --now brambs-sbx-fw brambs-runnerd`.
6. Cloud firewall: port 9000 only accepts the harness's private IP; nothing
   public.
7. In the harness's `.env`: `SANDBOX_URL=http://<private-ip>:9000` and
   `SANDBOX_TOKEN=<the token>`.

Check: from inside a container on the `brambs-sbx` network, a public site
responds, and `169.254.169.254` and the harness's private IP don't respond.

## Known gaps

- Cleanup: idle containers don't stop by themselves yet (`SANDBOX_IDLE_STOP`
  is declared in `runner.mjs`, but no job uses it).
- No disk quota per volume.
