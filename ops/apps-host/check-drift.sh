#!/usr/bin/env bash
# Compares the router.py/ctl.py next to this script (what is installed) and the
# brand file with what actually runs on the apps host.
# READ-ONLY: no write, no restart. Exits 1 if there is a divergence.
#
# Runs on a machine that has the control-channel key (APPS_HOST_SSH/APPS_HOST_KEY
# in the environment or in the .env of the folder it is called from):
#   ops/apps-host/check-drift.sh [--marca <file>] [--carimbo <version>]
# --marca: optional marca.json (default: whatever is next to this script).
# --carimbo: expected version, only displayed (default: commit of the folder it is called from).
set -uo pipefail
AQUI=$(cd "$(dirname "$0")" && pwd)
# Reads ONLY the two keys from .env, without executing the file: it has loose $ values in there.
env_get() { [ -f .env ] || return 0; sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
APPS_HOST_SSH="${APPS_HOST_SSH:-$(env_get APPS_HOST_SSH)}"
APPS_HOST_KEY="${APPS_HOST_KEY:-$(env_get APPS_HOST_KEY)}"
: "${APPS_HOST_SSH:?falta APPS_HOST_SSH no .env}"
: "${APPS_HOST_KEY:?falta APPS_HOST_KEY no .env}"

MARCA=""; SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --marca) MARCA="${2:?--marca precisa de um arquivo}"; shift ;;
    --carimbo) SHA="${2:?--carimbo precisa de um valor}"; shift ;;
    HEAD) ;;  # old way of calling it, right after the pull: the disk is already HEAD
    *) echo "uso: check-drift.sh [--marca <arquivo>] [--carimbo <versão>]"; exit 2 ;;
  esac
  shift
done
if [ -z "$MARCA" ] && [ -f "$AQUI/marca.json" ]; then MARCA="$AQUI/marca.json"; fi
[ -z "$MARCA" ] || [ -f "$MARCA" ] || { echo "não achei a marca $MARCA"; exit 1; }
[ -n "$SHA" ] || SHA=$(git rev-parse --short HEAD 2>/dev/null) || SHA=sem-versao

# -n closes stdin: without it ssh swallows the while loop's herestring and the loop stops at the 1st line.
rssh() { ssh -n -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
              -o ConnectTimeout=10 "$APPS_HOST_SSH" "$@"; }

# installed file : path on the host (marca.json is optional)
MAP="$AQUI/router.py:/opt/brambs-router/router.py
$AQUI/ctl.py:/opt/brambs-ctl/ctl.py
${MARCA:+$MARCA:/opt/brambs-router/marca.json}"

drift=0
while IFS=: read -r src dst; do
  [ -n "$src" ] || continue
  [ -f "$src" ] || { echo "não achei $src"; exit 1; }
  aqui_md5=$(md5sum "$src" | cut -d' ' -f1)
  box_md5=$(rssh "sudo md5sum '$dst' 2>/dev/null | cut -d' ' -f1")
  if [ "$aqui_md5" = "$box_md5" ]; then
    printf 'ok       %-12s %s\n' "$(basename "$src")" "$aqui_md5"
  else
    drift=1
    printf 'DIVERGE  %-12s aqui=%s  box=%s\n' "$(basename "$src")" "${aqui_md5:0:10}" "${box_md5:0:10}"
  fi
done <<< "$MAP"

box_sha=$(rssh "cat /opt/brambs-router/.deployed-sha 2>/dev/null" || true)
printf 'versão daqui=%s   último deploy carimbado na box=%s\n' "$SHA" "${box_sha:-<nenhum>}"
[ "$drift" = 0 ] || echo 'A box está diferente do que está instalado aqui. Rodar deploy.sh (exige autorização).'
exit "$drift"
