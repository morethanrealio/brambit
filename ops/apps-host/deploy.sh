#!/usr/bin/env bash
# Deploy do plano de controle dos apps: o que está instalado -> box de apps.
#
# Produção viva (apps de usuário final servindo tráfego). Por padrão só SIMULA;
# escrever de verdade exige --aplicar.
#
# Roda numa máquina com a chave do canal de controle (APPS_HOST_SSH/APPS_HOST_KEY
# no ambiente ou no .env da pasta de onde é chamado):
#   ops/apps-host/deploy.sh [--aplicar] [--marca <arquivo>] [--carimbo <versão>]
#
# Publica o router.py, ctl.py e test_auth.py que estão AO LADO deste script, ou
# seja, o que está instalado (neste repositório ou no pacote do núcleo).
# --marca: marca.json opcional (padrão: o que estiver ao lado deste script).
# --carimbo: versão gravada na box (padrão: commit da pasta de onde é chamado).
#
# Ordem router -> ctl é de propósito (ver README.md): roteador novo com registry
# velho é seguro; o inverso deixa app privado sem portão por alguns segundos.
set -uo pipefail
AQUI=$(cd "$(dirname "$0")" && pwd)
# Le SO as duas chaves do .env, sem executar o arquivo: tem valor com $ solto la dentro.
env_get() { [ -f .env ] || return 0; sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
APPS_HOST_SSH="${APPS_HOST_SSH:-$(env_get APPS_HOST_SSH)}"
APPS_HOST_KEY="${APPS_HOST_KEY:-$(env_get APPS_HOST_KEY)}"
: "${APPS_HOST_SSH:?falta APPS_HOST_SSH no .env}"
: "${APPS_HOST_KEY:?falta APPS_HOST_KEY no .env}"

APLICAR=0; MARCA=""; SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --aplicar) APLICAR=1 ;;
    --marca) MARCA="${2:?--marca precisa de um arquivo}"; shift ;;
    --carimbo) SHA="${2:?--carimbo precisa de um valor}"; shift ;;
    # Só pra quem ainda chama do jeito antigo logo depois do pull, quando o disco já é o HEAD.
    --ref) [ "${2:-}" = HEAD ] || { echo '--ref saiu: o deploy publica o que está no disco'; exit 2; }; shift ;;
    *) echo "uso: deploy.sh [--aplicar] [--marca <arquivo>] [--carimbo <versão>]"; exit 2 ;;
  esac
  shift
done
if [ -z "$MARCA" ] && [ -f "$AQUI/marca.json" ]; then MARCA="$AQUI/marca.json"; fi
if [ -n "$MARCA" ]; then
  [ -f "$MARCA" ] || { echo "FALHOU: não achei a marca $MARCA"; exit 1; }
  MARCA="$(cd "$(dirname "$MARCA")" && pwd)/$(basename "$MARCA")"
fi
[ -n "$SHA" ] || SHA=$(git rev-parse --short HEAD 2>/dev/null) || SHA=sem-versao

# -n fecha o stdin: sem isso o ssh engole o herestring do while e o loop para na 1a linha.
rssh() { ssh -n -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
               -o ConnectTimeout=15 "$APPS_HOST_SSH" "$@"; }
# rsend e a versao que MANDA arquivo pelo stdin.
rsend() { ssh -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
               -o ConnectTimeout=15 "$APPS_HOST_SSH" "$@"; }

STAMP=$(date +%s)
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
for f in router.py ctl.py test_auth.py; do
  cp "$AQUI/$f" "$SRC/$f" || { echo "FALHOU: não achei $f em $AQUI"; exit 1; }
done
# Opcional: nome, site, logo e selo da marca no roteador (ver router.py). Sem ela,
# a box fica com o que tem (ou a marca neutra).
[ -z "$MARCA" ] || cp "$MARCA" "$SRC/marca.json" || exit 1

# 1. Portão: o que vai subir tem que passar nos testes do próprio caminho.
echo "== testes da versão $SHA"
( cd "$SRC" && python3 test_auth.py ) || { echo 'FALHOU: teste. Nada foi enviado.'; exit 1; }
# 2. O que está diferente entre o git e a box?
MAP='router.py:/opt/brambs-router/router.py:brambs-router
ctl.py:/opt/brambs-ctl/ctl.py:
marca.json:/opt/brambs-router/marca.json:brambs-router'
PENDENTES=()
while IFS=: read -r f dst svc; do
  [ -n "$f" ] && [ -f "$SRC/$f" ] || continue
  a=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  b=$(rssh "sudo md5sum '$dst' 2>/dev/null | cut -d' ' -f1")
  if [ "$a" = "$b" ]; then echo "== igual: $f"
  else echo "== pendente: $f  aqui=${a:0:10} box=${b:0:10}"; PENDENTES+=("$f:$dst:$svc"); fi
done <<< "$MAP"

[ ${#PENDENTES[@]} -gt 0 ] || { echo 'Box já está igual ao que está instalado aqui. Nada a fazer.'; exit 0; }
[ "$APLICAR" = 1 ] || { echo; echo 'SIMULAÇÃO. Rode com --aplicar para enviar de verdade.'; exit 0; }

# 3. Envia, confere o md5 do que chegou e só então troca o arquivo em uso.
RESTART=0
for item in "${PENDENTES[@]}"; do
  IFS=: read -r f dst svc <<< "$item"
  a=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  echo "== enviando $f"
  rsend "cat > /tmp/dep.$STAMP.$f" < "$SRC/$f" || exit 1
  chegou=$(rssh "md5sum /tmp/dep.$STAMP.$f | cut -d' ' -f1")
  [ "$chegou" = "$a" ] || { echo "FALHOU: md5 do enviado não bate. Nada foi trocado."; exit 1; }
  if [ "${f##*.}" = py ]; then chk="python3 -m py_compile"; modo=0755; else chk="python3 -m json.tool"; modo=0644; fi
  rssh "$chk /tmp/dep.$STAMP.$f >/dev/null" || { echo 'FALHOU: arquivo inválido na box. Nada foi trocado.'; exit 1; }
  rssh "{ sudo test ! -e '$dst' || sudo cp -p '$dst' '$dst.bak.$STAMP'; } && sudo install -m $modo -o root -g root /tmp/dep.$STAMP.$f '$dst'" || exit 1
  [ -n "$svc" ] && RESTART=1
done

reverter() {
  echo 'revertendo para o backup'
  for item in "${PENDENTES[@]}"; do IFS=: read -r f dst svc <<< "$item"
    rssh "if sudo test -e '$dst.bak.$STAMP'; then sudo cp -p '$dst.bak.$STAMP' '$dst'; else sudo rm -f '$dst'; fi"; done
  [ "$RESTART" = 1 ] && rssh "sudo systemctl restart brambs-router"
}

# 4. Regressão na box, contra os dois arquivos que agora estão em uso.
echo "== testes na box"
rssh "mkdir -p /tmp/apt.$STAMP && sudo cp /opt/brambs-router/router.py /opt/brambs-ctl/ctl.py /tmp/apt.$STAMP/ && sudo chmod 644 /tmp/apt.$STAMP/*.py"
rsend "cat > /tmp/apt.$STAMP/test_auth.py" < "$SRC/test_auth.py"
if ! rssh "cd /tmp/apt.$STAMP && python3 test_auth.py"; then
  echo 'FALHOU o teste na box.'; reverter; exit 1
fi

# 5. Restart só se o roteador mudou (ctl.py é one-shot por chamada).
if [ "$RESTART" = 1 ]; then
  echo "== restart brambs-router"
  if ! rssh "sudo systemctl restart brambs-router && sleep 2 && systemctl is-active brambs-router"; then
    echo 'FALHOU o restart.'; reverter; exit 1
  fi
fi

# 6. Carimbo: a pergunta "qual versão está no ar?" passa a ter resposta.
rssh "echo '$SHA' | sudo tee /opt/brambs-router/.deployed-sha >/dev/null"
rssh "rm -rf /tmp/apt.$STAMP /tmp/dep.$STAMP.*"

echo "== conferência final"
bash "$AQUI/check-drift.sh" ${MARCA:+--marca "$MARCA"} --carimbo "$SHA"
