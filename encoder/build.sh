#!/bin/sh
# Builds the encoder app for every system the site offers (server/src/encoderRoutes.js).
# Usage: encoder/build.sh [output dir] (default encoder/dist). Needs Go 1.24+.
set -e
cd "$(dirname "$0")"
out="${1:-dist}"
version="${ENCODER_VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
mkdir -p "$out"
for target in windows/amd64 darwin/arm64 darwin/amd64 linux/amd64; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [ "$os" = windows ] && ext=".exe"
  echo "→ $os/$arch"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$out/watchparty-encoder-$os-$arch$ext" .
done
