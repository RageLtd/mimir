#!/usr/bin/env bash
#
# Build mimir-cc binaries for each supported platform.
#
# Each binary bundles the bun runtime + our code into a single ~50MB
# executable. Output goes to dist/<platform>/mimir-cc, which is the
# layout the /mimir-install slash command expects when copying the
# correct binary to ~/.local/bin/mimir-cc on the user's machine.

set -euo pipefail

cd "$(dirname "$0")"

mkdir -p dist/darwin-arm64 dist/linux-x64

echo "Building darwin-arm64..."
bun build src/cli.ts \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile=dist/darwin-arm64/mimir-cc

echo "Building linux-x64..."
bun build src/cli.ts \
  --compile \
  --target=bun-linux-x64 \
  --outfile=dist/linux-x64/mimir-cc

# `bun build --compile` writes a broken adhoc signature into the macOS
# binary — `codesign --verify` reports "code or signature have been
# modified" and Gatekeeper SIGKILLs the process at exec time with no
# stderr. Re-signing adhoc with `codesign --sign -` produces a valid
# signature and the binary runs cleanly. Only needed when building on
# macOS for the darwin-arm64 target; linux-x64 has no equivalent check.
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Re-signing darwin-arm64 binary (Bun's adhoc signature is broken)..."
  codesign --sign - --force dist/darwin-arm64/mimir-cc
  codesign --verify -vvv dist/darwin-arm64/mimir-cc
fi

echo
echo "Done. Binaries:"
ls -lh dist/darwin-arm64/mimir-cc dist/linux-x64/mimir-cc
