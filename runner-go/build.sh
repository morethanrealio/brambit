#!/bin/sh
# Builds the Runner executables that the /runner page offers for download.
#
#   PRODUCT  brand name, same as the server's (marca().nome). Default: Brambit.
#   SITE     address of the server the Runner calls. Default: http://localhost:8080.
#   SLUG     prefix for the files and the variables (brambit-runner-linux,
#            BRAMBIT_RUNNER_TOKEN). Default: PRODUCT lowercased, letters and
#            digits only, same rule as the server's slugDaMarca(). If the name has
#            an accent, pass SLUG by hand.
#   OUT_DIR  output folder for the executables. Default: web/public/runner-bin.
#   WINDOWS_ICON  .syso with the .exe's icon (optional; without it, default icon).
#
# The Mac app (zip with the .app, "Download for Mac" button) doesn't come from here: it's the
# Mac executable wrapped in a .app, assembled separately.
set -eu
cd "$(dirname "$0")"
PRODUCT="${PRODUCT:-Brambit}"
SITE="${SITE:-http://localhost:8080}"
SLUG="${SLUG:-$(printf %s "$PRODUCT" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')}"
OUT_DIR="${OUT_DIR:-../web/public/runner-bin}"
mkdir -p "$OUT_DIR"
X="-X 'main.produto=$PRODUCT' -X 'main.slug=$SLUG' -X 'main.siteURL=$SITE'"

build_one() { # GOOS GOARCH file [extra link flags]
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build -trimpath -ldflags="${4:-} -s -w $X" -o "$OUT_DIR/$3" .
  echo "built: $OUT_DIR/$3"
}
build_one darwin arm64 "$SLUG-runner-macos-arm64"
build_one darwin amd64 "$SLUG-runner-macos-intel"
build_one linux amd64 "$SLUG-runner-linux"
# -H windowsgui is NOT optional: without it the .exe comes out as a console program and
# opens a black terminal window on every run (see README).
if [ -n "${WINDOWS_ICON:-}" ]; then
  cp "$WINDOWS_ICON" rsrc_windows_amd64.syso
  trap 'rm -f rsrc_windows_amd64.syso' EXIT
fi
build_one windows amd64 "$SLUG-runner-windows.exe" "-H windowsgui"
