#!/bin/sh
#
# ensure-binary.sh — fetch a released Mimir plugin binary from a GitHub
# Release and make it runnable on this machine. Invoked by the plugin
# wrappers before launch and by the install flows, so the live binary at
# ~/.local/bin tracks the latest released version of its own package.
#
# CANONICAL SOURCE: packages/plugin-core/scripts/ensure-binary.sh.
# The copies at packages/{cc-plugin,codex-plugin}/scripts/ensure-binary.sh
# are byte-identical mirrors (drift-tested) — each plugin's marketplace
# checkout must be self-contained, and neither contains plugin-core.
# Edit here, then re-copy the mirrors.
#
# Usage: ensure-binary.sh [flavor]
#   cc (default) — mimir-cc, tracks cc-plugin/v* releases
#   codex        — mimir-codex-bin, tracks codex-plugin/v* releases
#
# RageLtd/mimir is PRIVATE, so release assets require auth. We download with
# `gh` (uses the caller's own gh auth — works for any repo collaborator) and
# fall back to curl + $GITHUB_TOKEN when gh is absent.
#
set -eu

REPO="RageLtd/mimir"
INSTALL_DIR="${HOME}/.local/bin"

# --- flavor selection ---------------------------------------------------------
# Releases in this repo are per-package (cc-plugin/vX.Y.Z, codex-plugin/vX.Y.Z,
# oc-plugin/vX.Y.Z, …), so the repo-wide "latest release" may belong to a
# different plugin. Each flavor pins its own tag prefix, binary, version
# marker, and dev pin. No-arg default stays `cc` — every cc wrapper already in
# the field calls this script with no arguments.
FLAVOR="${1:-cc}"
case "${FLAVOR}" in
  cc)
    BINARY_NAME="mimir-cc"
    TAG_PREFIX="cc-plugin/"
    VERSION_FILE="${HOME}/.mimir/.cc-version"
    DEV_PIN="${HOME}/.mimir/.cc-dev"
    ;;
  codex)
    BINARY_NAME="mimir-codex-bin"
    TAG_PREFIX="codex-plugin/"
    VERSION_FILE="${HOME}/.mimir/.codex-version"
    DEV_PIN="${HOME}/.mimir/.codex-dev"
    ;;
  *)
    echo "[mimir] Unknown flavor: ${FLAVOR} (expected cc or codex)" >&2
    exit 1
    ;;
esac
BINARY_PATH="${INSTALL_DIR}/${BINARY_NAME}"

# Developer pin: the package's dev-install.sh drops the pin file after swapping
# a local build over the installed binary. While it's present, never check for
# or download a release — that would clobber the dev build mid-iteration.
# Remove it (and re-run this script) to resume tracking releases.
if [ -f "${DEV_PIN}" ]; then
  echo "[mimir] dev build pinned (${DEV_PIN} present) — skipping release check." >&2
  exit 0
fi

# --- platform detection (alpha ships darwin-arm64 + linux-x64 only) ----------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "${OS}" in
  Darwin)
    case "${ARCH}" in
      arm64) PLATFORM="darwin-arm64" ;;
      *) echo "[mimir] Unsupported macOS arch: ${ARCH} (alpha is darwin-arm64 only)" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "${ARCH}" in
      x86_64|amd64) PLATFORM="linux-x64" ;;
      *) echo "[mimir] Unsupported Linux arch: ${ARCH} (alpha is linux-x64 only)" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "[mimir] Unsupported OS: ${OS}" >&2
    exit 1
    ;;
esac
ASSET_NAME="${BINARY_NAME}-${PLATFORM}"

have() { command -v "$1" >/dev/null 2>&1; }

# --- resolve the latest release tag for this flavor ---------------------------
latest_tag() {
  if have gh; then
    gh release list --repo "${REPO}" --limit 100 \
      --json tagName,isDraft,isPrerelease \
      --jq "first(.[] | select((.isDraft or .isPrerelease) | not) | select(.tagName | startswith(\"${TAG_PREFIX}\")) | .tagName) // empty" \
      2>/dev/null
  elif [ -n "${GITHUB_TOKEN:-}" ] && have curl; then
    # /releases is newest-first; take the first tag matching our prefix.
    curl -fsSL \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO}/releases?per_page=100" 2>/dev/null \
      | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//' \
      | grep "^${TAG_PREFIX}" | head -1
  fi
}

LATEST_TAG="$(latest_tag || true)"

# Offline / auth failure: keep a working binary if we already have one.
if [ -z "${LATEST_TAG}" ]; then
  if [ -x "${BINARY_PATH}" ]; then
    exit 0
  fi
  echo "[mimir] Cannot reach ${REPO} releases and no binary is installed." >&2
  if ! have gh; then
    echo "[mimir] Install the GitHub CLI (gh) and run 'gh auth login', or set GITHUB_TOKEN." >&2
  fi
  exit 1
fi

# --- skip when already current -----------------------------------------------
if [ -x "${BINARY_PATH}" ] && [ -f "${VERSION_FILE}" ]; then
  if [ "$(cat "${VERSION_FILE}")" = "${LATEST_TAG}" ]; then
    exit 0
  fi
fi

echo "[mimir] Fetching ${BINARY_NAME} ${LATEST_TAG} (${PLATFORM})..." >&2
mkdir -p "${INSTALL_DIR}"

# --- download ----------------------------------------------------------------
if have gh; then
  gh release download "${LATEST_TAG}" \
    --repo "${REPO}" \
    --pattern "${ASSET_NAME}" \
    --output "${BINARY_PATH}" \
    --clobber
elif [ -n "${GITHUB_TOKEN:-}" ] && have curl; then
  # Private-asset download needs the asset's API URL + an octet-stream Accept.
  ASSET_API_URL="$(curl -fsSL \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/tags/${LATEST_TAG}" \
    | grep -B3 "\"name\": *\"${ASSET_NAME}\"" | grep '"url"' | head -1 \
    | sed 's/.*"url": *"//;s/".*//')"
  if [ -z "${ASSET_API_URL}" ]; then
    echo "[mimir] Could not locate asset ${ASSET_NAME} in release ${LATEST_TAG}." >&2
    exit 1
  fi
  curl -fL \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/octet-stream" \
    "${ASSET_API_URL}" -o "${BINARY_PATH}"
else
  echo "[mimir] Need either gh (recommended) or curl + GITHUB_TOKEN to download." >&2
  exit 1
fi

chmod +x "${BINARY_PATH}"

# --- macOS: re-sign to clear the broken Bun adhoc signature ------------------
# `bun build --compile` writes a signature that fails codesign --verify, and
# Gatekeeper SIGKILLs the binary at exec (exit 137, no stderr). An ad-hoc
# re-sign produces a valid signature. CI never signs the darwin asset, so this
# client-side step is what makes it runnable.
if [ "${OS}" = "Darwin" ]; then
  codesign --force --sign - "${BINARY_PATH}" 2>/dev/null || true
fi

# --- record version ----------------------------------------------------------
mkdir -p "$(dirname "${VERSION_FILE}")"
echo "${LATEST_TAG}" > "${VERSION_FILE}"

echo "[mimir] ${BINARY_NAME} ${LATEST_TAG} ready at ${BINARY_PATH}" >&2
