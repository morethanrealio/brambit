#!/bin/bash
# Sandbox de código na SUA máquina (modo local), pra usar junto com `npm run local`.
#
# Uso (da raiz do repo):   ops/sandbox-host/local.sh
#
# Faz, nesta ordem, e pode rodar de novo à vontade (idempotente):
#   1. builda a imagem do sandbox;
#   2. cria a rede docker só-saída (10.200.0.0/16);
#   3. no Linux, liga o firewall da rede do sandbox (pede sudo): bloqueia a sua
#      rede local, o metadata de nuvem e a PRÓPRIA máquina; só sai pra internet;
#   4. confere se o DNS funciona de dentro do sandbox;
#   5. gera o token (fica em .local/sandbox.env) e imprime as 2 linhas do .env;
#   6. sobe o runnerd em 127.0.0.1:9000 neste terminal (Ctrl+C para).
#
# Diferente do firewall-box.sh (máquina dedicada), este NÃO apaga regras que já
# existam na sua máquina: usa cadeias próprias (BRAMBS-SBX e BRAMBS-SBX-IN).
# As regras somem no reboot; é só rodar o script de novo.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
IMAGE="${SANDBOX_IMAGE:-brambs-sandbox:latest}"
NETWORK="${SANDBOX_NETWORK:-brambs-sbx}"
SBX=10.200.0.0/16
PORT="${RUNNERD_PORT:-9000}"
ENVFILE="$ROOT/.local/sandbox.env"

die() { echo "[sandbox] $*" >&2; exit 1; }
say() { echo "[sandbox] $*"; }

command -v docker >/dev/null || die "Docker não encontrado. Instale o Docker e rode de novo."
docker info >/dev/null 2>&1 || die "o Docker não respondeu. Ele está rodando? Seu usuário tem acesso a ele (grupo docker)?"
command -v node >/dev/null || die "Node.js não encontrado."

# 1. imagem
say "buildando a imagem $IMAGE (a primeira vez demora)..."
docker build -q -t "$IMAGE" "$DIR" >/dev/null

# 2. rede
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$SBX" "$NETWORK" >/dev/null
  say "rede $NETWORK criada ($SBX)"
fi
SUBNET="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NETWORK")"
[ "$SUBNET" = "$SBX" ] || die "a rede $NETWORK já existe com outra faixa ($SUBNET); o firewall espera $SBX. Apague-a (docker network rm $NETWORK) e rode de novo."

# 3. firewall
if [ "$(uname -s)" = "Linux" ]; then
  command -v sudo >/dev/null || die "sudo não encontrado (o firewall precisa de root)."
  say "ligando o firewall da rede do sandbox (pede sudo)..."
  sudo bash -s "$SBX" <<'FW'
set -e
SBX="$1"
# saída (container -> fora): só internet e DNS público
iptables -N DOCKER-USER 2>/dev/null || true
iptables -N BRAMBS-SBX 2>/dev/null || iptables -F BRAMBS-SBX
iptables -A BRAMBS-SBX -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
for ip in 8.8.8.8 1.1.1.1; do
  iptables -A BRAMBS-SBX -d $ip -p udp --dport 53 -j RETURN
  iptables -A BRAMBS-SBX -d $ip -p tcp --dport 53 -j RETURN
done
for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  iptables -A BRAMBS-SBX -d $net -j DROP
done
iptables -A BRAMBS-SBX -j RETURN
iptables -C DOCKER-USER -s "$SBX" -j BRAMBS-SBX 2>/dev/null || iptables -I DOCKER-USER 1 -s "$SBX" -j BRAMBS-SBX
# entrada (container -> esta máquina): nada. Sem isso o sandbox alcança o runnerd,
# o banco do `npm run local` e qualquer serviço escutando aqui.
iptables -N BRAMBS-SBX-IN 2>/dev/null || iptables -F BRAMBS-SBX-IN
iptables -A BRAMBS-SBX-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
iptables -A BRAMBS-SBX-IN -j DROP
iptables -C INPUT -s "$SBX" -j BRAMBS-SBX-IN 2>/dev/null || iptables -I INPUT 1 -s "$SBX" -j BRAMBS-SBX-IN
FW
  NET_OK=1
else
  NET_OK=0
  echo
  echo "[sandbox] ATENÇÃO: fora do Linux (ex.: Docker Desktop no macOS) não há como este"
  echo "[sandbox] script bloquear a rede: o código rodado no sandbox alcança a sua rede"
  echo "[sandbox] local e serviços desta máquina. Use só com código seu, ou rode o"
  echo "[sandbox] sandbox numa máquina Linux (modo máquina dedicada, ver README)."
  [ "${SANDBOX_SEM_FIREWALL:-}" = "1" ] || die "pra seguir assim mesmo: SANDBOX_SEM_FIREWALL=1 $0"
fi

# 4. DNS de dentro do sandbox (o firewall só libera DNS pro 8.8.8.8 e 1.1.1.1)
if ! docker run --rm --network "$NETWORK" "$IMAGE" getent hosts example.com >/dev/null 2>&1; then
  echo "[sandbox] o sandbox não resolve nomes. Normalmente é o Docker usando o DNS da sua rede,"
  echo "[sandbox] que o firewall bloqueia. Ponha em /etc/docker/daemon.json (o daemon.json desta"
  echo "[sandbox] pasta é o exemplo):   { \"dns\": [\"8.8.8.8\", \"1.1.1.1\"] }"
  echo "[sandbox] reinicie o Docker e rode este script de novo."
  exit 1
fi
if [ "$NET_OK" = "1" ]; then
  # prova: abre uma porta de teste nesta máquina, no endereço que o sandbox enxerga,
  # e confere que o sandbox NÃO chega nela (e que daqui ela responde, senão a prova é vazia)
  GW="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NETWORK")"
  PROBE=19099
  node -e "require('net').createServer(s=>s.end('x')).listen($PROBE,'$GW')" & LP=$!
  sleep 1
  if ! (exec 3<>"/dev/tcp/$GW/$PROBE") 2>/dev/null; then
    kill $LP 2>/dev/null; die "não consegui abrir a porta de teste $GW:$PROBE; a prova do firewall não rodou."
  fi
  if docker run --rm --network "$NETWORK" "$IMAGE" timeout 3 bash -c "</dev/tcp/$GW/$PROBE" >/dev/null 2>&1; then
    kill $LP 2>/dev/null; die "o sandbox ainda alcança esta máquina ($GW); o firewall não pegou. Confira 'sudo iptables -S INPUT'."
  fi
  kill $LP 2>/dev/null; wait $LP 2>/dev/null || true
  say "firewall conferido: o sandbox não alcança esta máquina"
fi

# 5. token
mkdir -p "$ROOT/.local"
if [ ! -s "$ENVFILE" ]; then
  umask 077
  echo "RUNNER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")" > "$ENVFILE"
fi
# shellcheck disable=SC1090
. "$ENVFILE"
echo
echo "[sandbox] pronto. Coloque no .env (se ainda não estiver) e reinicie o npm run local:"
echo "SANDBOX_URL=http://127.0.0.1:$PORT"
echo "SANDBOX_TOKEN=$RUNNER_TOKEN"
echo

# 6. runnerd, só no loopback
export RUNNER_TOKEN RUNNERD_PORT="$PORT" RUNNERD_HOST=127.0.0.1 SANDBOX_IMAGE="$IMAGE" SANDBOX_NETWORK="$NETWORK"
cd "$DIR"
exec node runnerd.mjs
