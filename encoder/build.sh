#!/bin/sh
# Builds the encoder app for every system the site offers (server/src/encoderRoutes.js).
# Usage: encoder/build.sh [output dir] (default encoder/dist). Needs Go 1.24+.
# The version comes from encoder/VERSION (bump it for every change of the app: installed
# apps update themselves to a higher one, see update.go).
set -e
cd "$(dirname "$0")"
out="${1:-dist}"
version="${ENCODER_VERSION:-$(cat VERSION)}"
mkdir -p "$out"
for target in windows/amd64 darwin/arm64 darwin/amd64 linux/amd64; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  gui=""
  # Windows: no console window, the app lives near the clock (tray_windows.go).
  [ "$os" = windows ] && ext=".exe" && gui="-H windowsgui"
  echo "→ $os/$arch"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w $gui -X main.version=$version" \
    -o "$out/watchparty-encoder-$os-$arch$ext" .
done
echo "$version" > "$out/VERSION"
(cd "$out" && sha256sum watchparty-encoder-* > SHA256SUMS)
