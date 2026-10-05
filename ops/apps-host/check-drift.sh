#!/usr/bin/env bash
# Compara o que está no git com o que de fato roda na box de apps.
# SÓ LÊ: nenhuma escrita, nenhum restart. Sai 1 se houver divergência.
#
# Roda no box de prod, que é quem tem a chave do canal de controle:
#   ops/apps-host/check-drift.sh [ref]   (na raiz do repositório)
# ref padrão = HEAD. Pode passar outro ref (ex.: origin/main, o que foi mergeado),
# que não é a mesma coisa que a working tree do box.
set -uo pipefail
cd "$(dirname "$0")/../.."
# Le SO as duas chaves do .env, sem executar o arquivo: tem valor com $ solto la dentro.
env_get() { [ -f .env ] || return 0; sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
APPS_HOST_SSH="${APPS_HOST_SSH:-$(env_get APPS_HOST_SSH)}"
APPS_HOST_KEY="${APPS_HOST_KEY:-$(env_get APPS_HOST_KEY)}"
: "${APPS_HOST_SSH:?falta APPS_HOST_SSH no .env}"
: "${APPS_HOST_KEY:?falta APPS_HOST_KEY no .env}"

REF="${1:-HEAD}"
# -n fecha o stdin: sem isso o ssh engole o herestring do while e o loop para na 1a linha.
rssh() { ssh -n -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
              -o ConnectTimeout=10 "$APPS_HOST_SSH" "$@"; }

# arquivo no git : caminho na box
MAP='ops/apps-host/router.py:/opt/brambs-router/router.py
ops/apps-host/ctl.py:/opt/brambs-ctl/ctl.py
ops/apps-host/marca.json:/opt/brambs-router/marca.json'

drift=0
while IFS=: read -r src dst; do
  [ -n "$src" ] || continue
  # marca.json é opcional: sem ele no git, não há o que comparar.
  git cat-file -e "$REF:$src" 2>/dev/null || continue
  git_md5=$(git show "$REF:$src" | md5sum | cut -d' ' -f1)
  box_md5=$(rssh "sudo md5sum '$dst' 2>/dev/null | cut -d' ' -f1")
  if [ "$git_md5" = "$box_md5" ]; then
    printf 'ok       %-12s %s\n' "$(basename "$src")" "$git_md5"
  else
    drift=1
    printf 'DIVERGE  %-12s git=%s  box=%s\n' "$(basename "$src")" "${git_md5:0:10}" "${box_md5:0:10}"
  fi
done <<< "$MAP"

box_sha=$(rssh "cat /opt/brambs-router/.deployed-sha 2>/dev/null" || true)
printf '%s=%s   último deploy carimbado na box=%s\n' \
  "$REF" "$(git rev-parse --short "$REF")" "${box_sha:-<nenhum>}"
[ "$drift" = 0 ] || echo 'A box está diferente do git. Rodar ops/apps-host/deploy.sh (exige autorização).'
exit "$drift"
