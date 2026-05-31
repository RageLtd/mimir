#!/usr/bin/env bash
#
# dev-install.sh — build mimir-cc from local source and swap it in over the
# running binary at ~/.local/bin/mimir-cc. This is the developer counterpart to
# the release path: /mimir-install and the `mimir` wrapper now DOWNLOAD released
# binaries via scripts/ensure-binary.sh and no longer build from source, so this
# script is how you test uncommitted changes.
#
# It also PINS dev mode (~/.mimir/.cc-dev) so the wrapper's on-launch update
# check won't download a release over your build. Remove the pin to resume
# tracking releases (printed at the end).
#
# Assumes you've installed Mimir at least once (/mimir-install) so the wrapper
# and ~/.mimir/config.json already exist.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PKG_DIR"

# 1. Build both targets. build.sh re-signs the darwin binary adhoc on macOS.
./build.sh

# 2. Select the binary for THIS platform (matches build.sh's output layout).
case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64) PLATFORM="darwin-arm64" ;;
      *) echo "dev-install: unsupported macOS arch $(uname -m)" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) PLATFORM="linux-x64" ;;
      *) echo "dev-install: unsupported Linux arch $(uname -m)" >&2; exit 1 ;;
    esac
    ;;
  *) echo "dev-install: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

SRC="${PKG_DIR}/dist/${PLATFORM}/mimir-cc"
DEST="${HOME}/.local/bin/mimir-cc"
mkdir -p "$(dirname "$DEST")"

# 3. Atomic replace. A running mimir-cc (hooks, MCP server) keeps its inode;
#    new invocations pick up the fresh build. Overwriting in place could corrupt
#    an in-flight process (ETXTBSY on Linux) — rename within the same dir is safe.
TMP="$(dirname "$DEST")/.mimir-cc.dev.$$"
cp "$SRC" "$TMP"
chmod +x "$TMP"
mv -f "$TMP" "$DEST"

# 4. Keep the materialized updater in sync with source (so its dev-pin logic is
#    live), then pin dev mode so ensure-binary.sh won't overwrite this build.
mkdir -p "${HOME}/.mimir"
cp "${PKG_DIR}/scripts/ensure-binary.sh" "${HOME}/.mimir/ensure-binary.sh"
chmod +x "${HOME}/.mimir/ensure-binary.sh"
touch "${HOME}/.mimir/.cc-dev"

echo
echo "dev-install: ${DEST} is now your local ${PLATFORM} build (auto-update pinned off)."
echo "  • Changed bundled templates or install/config logic? Re-materialize ~/.mimir with:"
echo "        mimir-cc update"
echo "  • Resume tracking releases:"
echo "        rm ~/.mimir/.cc-dev && ~/.mimir/ensure-binary.sh"
