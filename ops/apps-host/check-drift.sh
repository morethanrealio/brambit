#!/usr/bin/env bash
# Compares the router.py/ctl.py next to this script (what is installed) and the
# brand file with what actually runs on the apps host.
# READ-ONLY: no write, no restart. Exits 1 if there is a divergence.
#
# Runs on a machine that has the control-channel key (APPS_HOST_SSH/APPS_HOST_KEY
# in the environment or in the .env of the folder it is called from):
#   ops/apps-host/check-drift.sh [--brand <file>] [--stamp <version>]
# --brand: optional brand.json (default: whatever is next to this script).
# --stamp: expected version, only displayed (default: commit of the folder it is called from).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# Reads ONLY the two keys from .env, without executing the file: it has loose $ values in there.
env_get() { [ -f .env ] || return 0; sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
APPS_HOST_SSH="${APPS_HOST_SSH:-$(env_get APPS_HOST_SSH)}"
APPS_HOST_KEY="${APPS_HOST_KEY:-$(env_get APPS_HOST_KEY)}"
: "${APPS_HOST_SSH:?APPS_HOST_SSH is missing from .env}"
: "${APPS_HOST_KEY:?APPS_HOST_KEY is missing from .env}"

BRAND=""; SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --brand) BRAND="${2:?--brand needs a file}"; shift ;;
    --stamp) SHA="${2:?--stamp needs a value}"; shift ;;
    HEAD) ;;  # old way of calling it, right after the pull: the disk is already HEAD
    *) echo "usage: check-drift.sh [--brand <file>] [--stamp <version>]"; exit 2 ;;
  esac
  shift
done
if [ -z "$BRAND" ] && [ -f "$HERE/brand.json" ]; then BRAND="$HERE/brand.json"; fi
[ -z "$BRAND" ] || [ -f "$BRAND" ] || { echo "brand file $BRAND not found"; exit 1; }
[ -n "$SHA" ] || SHA=$(git rev-parse --short HEAD 2>/dev/null) || SHA=no-version

# -n closes stdin: without it ssh swallows the while loop's herestring and the loop stops at the 1st line.
rssh() { ssh -n -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
              -o ConnectTimeout=10 "$APPS_HOST_SSH" "$@"; }

# installed file : path on the host (brand.json is optional)
MAP="$HERE/router.py:/opt/brambs-router/router.py
$HERE/ctl.py:/opt/brambs-ctl/ctl.py
${BRAND:+$BRAND:/opt/brambs-router/brand.json}"

drift=0
while IFS=: read -r src dst; do
  [ -n "$src" ] || continue
  [ -f "$src" ] || { echo "$src not found"; exit 1; }
  here_md5=$(md5sum "$src" | cut -d' ' -f1)
  host_md5=$(rssh "sudo md5sum '$dst' 2>/dev/null | cut -d' ' -f1")
  if [ "$here_md5" = "$host_md5" ]; then
    printf 'ok       %-12s %s\n' "$(basename "$src")" "$here_md5"
  else
    drift=1
    printf 'DIVERGE  %-12s here=%s  host=%s\n' "$(basename "$src")" "${here_md5:0:10}" "${host_md5:0:10}"
  fi
done <<< "$MAP"

host_sha=$(rssh "cat /opt/brambs-router/.deployed-sha 2>/dev/null" || true)
printf 'version here=%s   last deploy stamped on the host=%s\n' "$SHA" "${host_sha:-<none>}"
[ "$drift" = 0 ] || echo 'The host differs from what is installed here. Run deploy.sh (needs authorization).'
exit "$drift"
