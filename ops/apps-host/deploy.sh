#!/usr/bin/env bash
# Deploy of the apps control plane: what is installed -> apps host.
#
# Live production (end-user apps serving traffic). By default it only SIMULATES;
# writing for real requires --apply.
#
# Runs on a machine that has the control-channel key (APPS_HOST_SSH/APPS_HOST_KEY
# in the environment or in the .env of the folder it is called from):
#   ops/apps-host/deploy.sh [--apply] [--brand <file>] [--stamp <version>]
#
# Publishes the router.py, ctl.py and test_auth.py sitting NEXT TO this
# script, i.e. whatever is installed (in this repository or in the core
# package).
# --brand: optional brand.json (default: whatever is next to this script).
# --stamp: version recorded on the host (default: commit of the folder it is called from).
#
# Order router -> ctl is on purpose (see README.md): new router with old
# registry is safe; the reverse leaves a private app without a gate for a few seconds.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# Reads ONLY the two keys from .env, without executing the file: it has loose $ values in there.
env_get() { [ -f .env ] || return 0; sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
APPS_HOST_SSH="${APPS_HOST_SSH:-$(env_get APPS_HOST_SSH)}"
APPS_HOST_KEY="${APPS_HOST_KEY:-$(env_get APPS_HOST_KEY)}"
: "${APPS_HOST_SSH:?APPS_HOST_SSH is missing from .env}"
: "${APPS_HOST_KEY:?APPS_HOST_KEY is missing from .env}"

APPLY=0; BRAND=""; SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --brand) BRAND="${2:?--brand needs a file}"; shift ;;
    --stamp) SHA="${2:?--stamp needs a value}"; shift ;;
    # Only for whoever still calls it the old way right after the pull, when the disk is already HEAD.
    --ref) [ "${2:-}" = HEAD ] || { echo '--ref is gone: the deploy publishes what is on disk'; exit 2; }; shift ;;
    *) echo "usage: deploy.sh [--apply] [--brand <file>] [--stamp <version>]"; exit 2 ;;
  esac
  shift
done
if [ -z "$BRAND" ] && [ -f "$HERE/brand.json" ]; then BRAND="$HERE/brand.json"; fi
if [ -n "$BRAND" ]; then
  [ -f "$BRAND" ] || { echo "FAILED: brand file $BRAND not found"; exit 1; }
  BRAND="$(cd "$(dirname "$BRAND")" && pwd)/$(basename "$BRAND")"
fi
[ -n "$SHA" ] || SHA=$(git rev-parse --short HEAD 2>/dev/null) || SHA=no-version

# -n closes stdin: without it ssh swallows the while loop's herestring and the loop stops at the 1st line.
rssh() { ssh -n -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
               -o ConnectTimeout=15 "$APPS_HOST_SSH" "$@"; }
# rsend is the version that SENDS a file over stdin.
rsend() { ssh -i "$APPS_HOST_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
               -o ConnectTimeout=15 "$APPS_HOST_SSH" "$@"; }

STAMP=$(date +%s)
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
for f in router.py ctl.py test_auth.py; do
  cp "$HERE/$f" "$SRC/$f" || { echo "FAILED: $f not found in $HERE"; exit 1; }
done
# Optional: brand name, site, logo and badge in the router (see router.py). Without it,
# the host keeps what it has (or the neutral brand).
[ -z "$BRAND" ] || cp "$BRAND" "$SRC/brand.json" || exit 1

# 1. Gate: what's about to go up has to pass its own path's tests.
echo "== tests of version $SHA"
( cd "$SRC" && python3 test_auth.py ) || { echo 'FAILED: test. Nothing was sent.'; exit 1; }
# 2. What's different between git and the host?
MAP='router.py:/opt/brambs-router/router.py:brambs-router
ctl.py:/opt/brambs-ctl/ctl.py:
brand.json:/opt/brambs-router/brand.json:brambs-router'
PENDING=()
while IFS=: read -r f dst svc; do
  [ -n "$f" ] && [ -f "$SRC/$f" ] || continue
  a=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  b=$(rssh "sudo md5sum '$dst' 2>/dev/null | cut -d' ' -f1")
  if [ "$a" = "$b" ]; then echo "== same: $f"
  else echo "== pending: $f  here=${a:0:10} host=${b:0:10}"; PENDING+=("$f:$dst:$svc"); fi
done <<< "$MAP"

[ ${#PENDING[@]} -gt 0 ] || { echo 'The host already matches what is installed here. Nothing to do.'; exit 0; }
[ "$APPLY" = 1 ] || { echo; echo 'DRY RUN. Run with --apply to send for real.'; exit 0; }

# 3. Send, check the md5 of what arrived, and only then swap the file in use.
RESTART=0
for item in "${PENDING[@]}"; do
  IFS=: read -r f dst svc <<< "$item"
  a=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  echo "== sending $f"
  rsend "cat > /tmp/dep.$STAMP.$f" < "$SRC/$f" || exit 1
  arrived=$(rssh "md5sum /tmp/dep.$STAMP.$f | cut -d' ' -f1")
  [ "$arrived" = "$a" ] || { echo "FAILED: md5 of the sent file does not match. Nothing was swapped."; exit 1; }
  if [ "${f##*.}" = py ]; then chk="python3 -m py_compile"; mode=0755; else chk="python3 -m json.tool"; mode=0644; fi
  rssh "$chk /tmp/dep.$STAMP.$f >/dev/null" || { echo 'FAILED: invalid file on the host. Nothing was swapped.'; exit 1; }
  rssh "{ sudo test ! -e '$dst' || sudo cp -p '$dst' '$dst.bak.$STAMP'; } && sudo install -m $mode -o root -g root /tmp/dep.$STAMP.$f '$dst'" || exit 1
  [ -n "$svc" ] && RESTART=1
done

revert() {
  echo 'reverting to the backup'
  for item in "${PENDING[@]}"; do IFS=: read -r f dst svc <<< "$item"
    rssh "if sudo test -e '$dst.bak.$STAMP'; then sudo cp -p '$dst.bak.$STAMP' '$dst'; else sudo rm -f '$dst'; fi"; done
  [ "$RESTART" = 1 ] && rssh "sudo systemctl restart brambs-router"
}

# 4. Regression on the host, against the two files that are now in use.
echo "== tests on the host"
rssh "mkdir -p /tmp/apt.$STAMP && sudo cp /opt/brambs-router/router.py /opt/brambs-ctl/ctl.py /tmp/apt.$STAMP/ && sudo chmod 644 /tmp/apt.$STAMP/*.py"
rsend "cat > /tmp/apt.$STAMP/test_auth.py" < "$SRC/test_auth.py"
if ! rssh "cd /tmp/apt.$STAMP && python3 test_auth.py"; then
  echo 'FAILED: the test on the host.'; revert; exit 1
fi

# 5. Restart only if the router changed (ctl.py is one-shot per call).
if [ "$RESTART" = 1 ]; then
  echo "== restart brambs-router"
  if ! rssh "sudo systemctl restart brambs-router && sleep 2 && systemctl is-active brambs-router"; then
    echo 'FAILED: the restart.'; revert; exit 1
  fi
fi

# 6. Containers move to the current naming (idempotent; no-op when there is
# nothing to move). Not reverted on failure: an app left on the old name moves
# on its own on the next ctl.py call for it.
echo "== container names"
mig=$(rssh "echo '{\"verb\":\"migrate_names\"}' | sudo python3 /opt/brambs-ctl/ctl.py")
echo "$mig"
case "$mig" in *'"ok": true'*) ;; *) echo 'FAILED: the name migration. Run the deploy again.'; exit 1 ;; esac

# 7. Stamp: the question "which version is live?" now has an answer.
rssh "echo '$SHA' | sudo tee /opt/brambs-router/.deployed-sha >/dev/null"
rssh "rm -rf /tmp/apt.$STAMP /tmp/dep.$STAMP.*"

echo "== final check"
bash "$HERE/check-drift.sh" ${BRAND:+--brand "$BRAND"} --stamp "$SHA"
