# Sandbox de código (runnerd)

Serviço à parte onde o assistente roda código do usuário (python, shell, node,
scraping, montar arquivos). O harness fala com ele por HTTP quando o `.env` tem
`SANDBOX_URL` e `SANDBOX_TOKEN` (cliente em `web/sandbox.mjs`); sem as duas, as
ferramentas de código somem e o resto funciona normal.

Código de usuário é código arbitrário. Por isso o sandbox NUNCA roda na máquina
do harness em produção, e o isolamento não depende só do Docker.

## Peças

| Arquivo | O que é |
| --- | --- |
| `Dockerfile` | imagem `brambs-sandbox` (debian-slim, python, node 20, libs de dados/scraping), usuário não-root |
| `runner.mjs` | um container por usuário (`sbx_<id>`) com volume próprio (`sbxvol_<id>`); comandos via `docker exec` |
| `runnerd.mjs` | HTTP fino na frente do runner, Bearer `RUNNER_TOKEN` (sem token, não sobe) |
| `local.sh` | modo local: tudo de uma vez na sua máquina, pra usar com `npm run local` |
| `firewall-box.sh` | firewall da máquina dedicada (o que roda em produção) |
| `systemd/` | serviços da máquina dedicada (firewall e runnerd) |
| `daemon.json` | DNS do Docker (o firewall só libera DNS pro 8.8.8.8 e 1.1.1.1) |
| `runnerd.env.example` | variáveis do runnerd |

Endpoints (POST com JSON, exceto `/health`): `/shell`, `/write`, `/read`,
`/readfile` (bytes crus), `/stop`, `GET /health`. Detalhe no topo do `runnerd.mjs`.

## Isolamento

No container (flags em `runner.mjs`): usuário não-root, `--cap-drop ALL`,
`no-new-privileges`, rootfs só leitura (graváveis só `/workspace` e `/tmp`),
limite de memória, CPU e processos, timeout por comando. O socket do Docker
nunca é montado no container.

Na máquina (firewall, porque o Docker sozinho não basta): a rede do sandbox
(`brambs-sbx`, 10.200.0.0/16) sai pra internet, mas não alcança metadata de
nuvem (169.254/16) nem redes privadas (10/8, 172.16/12, 192.168/16). Isso
impede o código do usuário de tocar banco, outros servidores ou credenciais
da instância.

## Modo local (Linux com Docker)

```bash
ops/sandbox-host/local.sh
```

Builda a imagem, cria a rede, liga o firewall (pede `sudo`), confere o DNS e
prova que o sandbox não alcança a sua máquina, gera um token em
`.local/sandbox.env` e sobe o runnerd em `127.0.0.1:9000` naquele terminal.
Ele imprime as duas linhas pra colar no `.env`; depois reinicie o `npm run local`.

No modo local o firewall usa cadeias próprias (`BRAMBS-SBX` e `BRAMBS-SBX-IN`)
e não apaga nenhuma regra que já exista na sua máquina. Além das redes privadas,
bloqueia o acesso do sandbox à própria máquina (senão ele alcançaria o runnerd e
qualquer serviço escutando aí). As regras somem no reboot: rode o script de novo.

Fora do Linux (Docker Desktop no macOS ou Windows) o Docker roda numa VM e o
script não tem como bloquear a rede: o código do sandbox alcança a sua rede
local. O script recusa seguir, a menos que você rode com
`SANDBOX_SEM_FIREWALL=1`; faça isso só com código seu.

## Máquina dedicada (produção)

Uma máquina Linux só pra isso, na mesma rede privada do harness, com Docker e
Node 18 ou mais novo (testado em AL2023, t3.small).

1. Copie esta pasta pra `/home/ec2-user/sandbox` e builde:
   `docker build -t brambs-sandbox:latest /home/ec2-user/sandbox`.
2. Rede: `docker network create --subnet 10.200.0.0/16 brambs-sbx`.
3. DNS: `daemon.json` em `/etc/docker/daemon.json` e reinicie o Docker.
4. Firewall: `firewall-box.sh` em `/usr/local/bin/brambs-sbx-setup.sh` e
   `systemd/brambs-sbx-fw.service` em `/etc/systemd/system/`. Esse script
   ZERA a cadeia `DOCKER-USER` a cada execução; foi feito pra máquina que só
   serve o sandbox. Não use numa máquina com outras regras ali.
5. runnerd: `runnerd.env.example` vira `/etc/brambs-runnerd.env` (`chmod 600`,
   token novo e longo) e `systemd/brambs-runnerd.service` vai em
   `/etc/systemd/system/`. Depois `systemctl daemon-reload` e
   `systemctl enable --now brambs-sbx-fw brambs-runnerd`.
6. Firewall da nuvem: porta 9000 aceita só o IP privado do harness; nada público.
7. No `.env` do harness: `SANDBOX_URL=http://<ip-privado>:9000` e
   `SANDBOX_TOKEN=<o token>`.

Conferência: de dentro de um container na rede `brambs-sbx`, um site público
responde, e `169.254.169.254` e o IP privado do harness não respondem.

## Pendências conhecidas

- Faxina: containers ociosos não param sozinhos ainda (`SANDBOX_IDLE_STOP` está
  declarado no `runner.mjs`, mas nenhum job usa).
- Sem cota de disco por volume.
