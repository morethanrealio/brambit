#!/bin/sh
# Builds the Runner executables that the /runner page offers for download.
#
#   PRODUTO  brand name, same as the server's (marca().nome). Default: Brambit.
#   SITE     address of the server the Runner calls. Default: http://localhost:8080.
#   SLUG     prefix for the files and the variables (brambit-runner-linux,
#            BRAMBIT_RUNNER_TOKEN). Default: PRODUTO lowercased, letters and
#            digits only, same rule as the server's slugDaMarca(). If the name has
#            an accent, pass SLUG by hand.
#   SAIDA    output folder for the executables. Default: web/public/runner-bin.
#   ICONE_WINDOWS  .syso with the .exe's icon (optional; without it, default icon).
#
# The Mac app (zip with the .app, "Download for Mac" button) doesn't come from here: it's the
# Mac executable wrapped in a .app, assembled separately.
set -eu
cd "$(dirname "$0")"
PRODUTO="${PRODUTO:-Brambit}"
SITE="${SITE:-http://localhost:8080}"
SLUG="${SLUG:-$(printf %s "$PRODUTO" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')}"
SAIDA="${SAIDA:-../web/public/runner-bin}"
mkdir -p "$SAIDA"
X="-X 'main.produto=$PRODUTO' -X 'main.slug=$SLUG' -X 'main.siteURL=$SITE'"

gerar() { # GOOS GOARCH file [extra link flags]
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build -trimpath -ldflags="${4:-} -s -w $X" -o "$SAIDA/$3" .
  echo "gerado: $SAIDA/$3"
}
gerar darwin arm64 "$SLUG-runner-macos-arm64"
gerar darwin amd64 "$SLUG-runner-macos-intel"
gerar linux amd64 "$SLUG-runner-linux"
# -H windowsgui is NOT optional: without it the .exe comes out as a console program and
# opens a black terminal window on every run (see README).
if [ -n "${ICONE_WINDOWS:-}" ]; then
  cp "$ICONE_WINDOWS" rsrc_windows_amd64.syso
  trap 'rm -f rsrc_windows_amd64.syso' EXIT
fi
gerar windows amd64 "$SLUG-runner-windows.exe" "-H windowsgui"
