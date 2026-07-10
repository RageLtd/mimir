#!/usr/bin/env bash
#
# Build mimir-codex-bin binaries for each supported platform.
#
# Each binary bundles the bun runtime + our code into a single ~50MB
# executable. Output goes to dist/<platform>/mimir-codex-bin.

set -euo pipefail

cd "$(dirname "$0")"

mkdir -p dist/darwin-arm64 dist/linux-x64

echo "Building darwin-arm64..."
bun build src/cli.ts \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile=dist/darwin-arm64/mimir-codex-bin

echo "Building linux-x64..."
bun build src/cli.ts \
  --compile \
  --target=bun-linux-x64 \
  --outfile=dist/linux-x64/mimir-codex-bin

# `bun build --compile` writes a broken adhoc signature into the macOS
# binary — Gatekeeper SIGKILLs the process at exec time with no stderr.
# Re-signing adhoc produces a valid signature. Only needed on macOS for
# the darwin-arm64 target.
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Re-signing darwin-arm64 binary (Bun's adhoc signature is broken)..."
  codesign --sign - --force dist/darwin-arm64/mimir-codex-bin
  codesign --verify -vvv dist/darwin-arm64/mimir-codex-bin
fi

echo
echo "Done. Binaries:"
ls -lh dist/darwin-arm64/mimir-codex-bin dist/linux-x64/mimir-codex-bin
