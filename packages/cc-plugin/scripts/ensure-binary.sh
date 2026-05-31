#!/bin/sh
#
# ensure-binary.sh — fetch the mimir-cc binary from a GitHub Release and make
# it runnable on this machine. Invoked by the `mimir` wrapper before launch and
# by /mimir-install, so the live binary at ~/.local/bin/mimir-cc tracks the
# latest released version.
#
# RageLtd/mimir is PRIVATE, so release assets require auth. We download with
# `gh` (uses the caller's own gh auth — works for any repo collaborator) and
# fall back to curl + $GITHUB_TOKEN when gh is absent.
#
set -eu

REPO="RageLtd/mimir"
BINARY_NAME="mimir-cc"
INSTALL_DIR="${HOME}/.local/bin"
BINARY_PATH="${INSTALL_DIR}/${BINARY_NAME}"
VERSION_FILE="${HOME}/.mimir/.cc-version"

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

# --- resolve the latest release tag ------------------------------------------
latest_tag() {
  if have gh; then
    gh release view --repo "${REPO}" --json tagName -q .tagName 2>/dev/null
  elif [ -n "${GITHUB_TOKEN:-}" ] && have curl; then
    curl -fsSL \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//'
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
