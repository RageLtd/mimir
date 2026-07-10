#!/usr/bin/env bash
#
# Dev-loop install: build the current checkout's binary for this
# machine's platform, land it at ~/.local/bin/mimir-codex-bin, then run
# the installer against the given mimir-server URL (or re-run update
# when omitted).
#
# Usage: scripts/dev-install.sh [<mimir-server-url>]

set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -sm)" in
  "Darwin arm64") PLATFORM="darwin-arm64" TARGET="bun-darwin-arm64" ;;
  "Linux x86_64") PLATFORM="linux-x64" TARGET="bun-linux-x64" ;;
  *)
    echo "Unsupported platform: $(uname -sm)" >&2
    exit 1
    ;;
esac

mkdir -p "dist/$PLATFORM"
bun build src/cli.ts --compile --target="$TARGET" \
  --outfile="dist/$PLATFORM/mimir-codex-bin"

if [[ "$PLATFORM" == "darwin-arm64" ]]; then
  codesign --sign - --force "dist/$PLATFORM/mimir-codex-bin"
fi

mkdir -p "$HOME/.local/bin"
# rm before cp: overwriting an existing signed Mach-O in place leaves the
# kernel's cached code-signature for that inode stale, and the next exec
# dies with SIGKILL and no stderr. A fresh inode avoids it.
rm -f "$HOME/.local/bin/mimir-codex-bin"
cp "dist/$PLATFORM/mimir-codex-bin" "$HOME/.local/bin/mimir-codex-bin"
chmod +x "$HOME/.local/bin/mimir-codex-bin"

if [[ $# -ge 1 ]]; then
  exec "$HOME/.local/bin/mimir-codex-bin" install "$1"
else
  exec "$HOME/.local/bin/mimir-codex-bin" update
fi
