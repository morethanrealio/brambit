#!/bin/sh
# Gera os executáveis do Runner que a página /runner oferece pra baixar.
#
#   PRODUTO  nome da marca, igual ao do servidor (marca().nome). Padrão: Brambit.
#   SITE     endereço do servidor que o Runner chama. Padrão: http://localhost:8080.
#   SLUG     prefixo dos arquivos e das variáveis (brambit-runner-linux,
#            BRAMBIT_RUNNER_TOKEN). Padrão: PRODUTO em minúsculas, só letras e
#            números, a mesma regra do slugDaMarca() do servidor. Com acento no
#            nome, passe o SLUG à mão.
#   SAIDA    pasta dos executáveis. Padrão: web/public/runner-bin.
#   ICONE_WINDOWS  .syso com o ícone do .exe (opcional; sem ele, ícone padrão).
#
# O app do Mac (zip com o .app, botão "Baixar para Mac") não sai daqui: é o
# executável do Mac embrulhado num .app, montado à parte.
set -eu
cd "$(dirname "$0")"
PRODUTO="${PRODUTO:-Brambit}"
SITE="${SITE:-http://localhost:8080}"
SLUG="${SLUG:-$(printf %s "$PRODUTO" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')}"
SAIDA="${SAIDA:-../web/public/runner-bin}"
mkdir -p "$SAIDA"
X="-X 'main.produto=$PRODUTO' -X 'main.slug=$SLUG' -X 'main.siteURL=$SITE'"

gerar() { # GOOS GOARCH arquivo [flags extras de link]
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build -trimpath -ldflags="${4:-} -s -w $X" -o "$SAIDA/$3" .
  echo "gerado: $SAIDA/$3"
}
gerar darwin arm64 "$SLUG-runner-macos-arm64"
gerar darwin amd64 "$SLUG-runner-macos-intel"
gerar linux amd64 "$SLUG-runner-linux"
# -H windowsgui NÃO é opcional: sem ela o .exe sai como programa de console e
# abre uma janela de terminal preta a cada execução (ver README).
if [ -n "${ICONE_WINDOWS:-}" ]; then
  cp "$ICONE_WINDOWS" rsrc_windows_amd64.syso
  trap 'rm -f rsrc_windows_amd64.syso' EXIT
fi
gerar windows amd64 "$SLUG-runner-windows.exe" "-H windowsgui"
