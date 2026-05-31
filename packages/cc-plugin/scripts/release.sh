#!/bin/sh
# Automatic semantic versioning for the cc-plugin package inside the mimir
# monorepo, driven by conventional commits.
#
# Usage: scripts/release.sh [--dry-run] [--no-tag] [--no-commit]
#
# Monorepo-scoped, unlike the standalone cartographer/goldfish scripts:
#   - the last tag is looked up in the `cc-plugin/v*` namespace only
#   - only commits touching packages/cc-plugin/** count toward the bump
#   - the bumped manifest is packages/cc-plugin/.claude-plugin/plugin.json
#   - the tag created is `cc-plugin/v<version>`
# so a server- or acp-only change never triggers a cc-plugin release.
#
# Bump rules (conventional commits):
#   feat!:, fix!:, BREAKING CHANGE  → major
#   feat:                           → minor
#   fix|refactor|perf|revert|build  → patch
#   docs:, chore:, test:, style:, ci: → no release
set -e

DRY_RUN=false
NO_TAG=false
NO_COMMIT=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-tag) NO_TAG=true ;;
    --no-commit) NO_COMMIT=true ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PKG_PATH="packages/cc-plugin"
PLUGIN_JSON="${PKG_PATH}/.claude-plugin/plugin.json"
TAG_PREFIX="cc-plugin/v"

CURRENT_VERSION="$(jq -r '.version' "$PLUGIN_JSON")"
LAST_TAG="$(git tag --list "${TAG_PREFIX}*" --sort=-v:refname | head -1)"

# First release: tag the current manifest version as-is, no bump. Subsequent
# runs bump relative to this tag.
if [ -z "$LAST_TAG" ]; then
  NEW_VERSION="$CURRENT_VERSION"
  BUMP_TYPE="initial"
  echo "[release] Last tag: (none)"
  echo "[release] Bump type: $BUMP_TYPE"
  echo "[release] Version: $CURRENT_VERSION → $NEW_VERSION"
else
  RANGE="${LAST_TAG}..HEAD"
  COMMITS="$(git log "$RANGE" --format='%s' -- "$PKG_PATH" 2>/dev/null || echo '')"

  if [ -z "$COMMITS" ]; then
    echo "[release] No commits touching ${PKG_PATH} since ${LAST_TAG}. Nothing to do."
    exit 0
  fi

  HAS_BREAKING=false
  HAS_FEAT=false
  HAS_PATCH=false
  COUNT=0
  while IFS= read -r msg; do
    [ -z "$msg" ] && continue
    COUNT=$((COUNT + 1))
    case "$msg" in
      *"BREAKING CHANGE"*|*"BREAKING-CHANGE"*) HAS_BREAKING=true ;;
    esac
    echo "$msg" | grep -qE '^[a-z]+(\(.+\))?!:' && HAS_BREAKING=true
    echo "$msg" | grep -qE '^feat(\(.+\))?:' && HAS_FEAT=true
    echo "$msg" | grep -qE '^(fix|refactor|perf|revert|build)(\(.+\))?:' && HAS_PATCH=true
  done <<EOF
$COMMITS
EOF

  if $HAS_BREAKING; then
    BUMP_TYPE="major"
  elif $HAS_FEAT; then
    BUMP_TYPE="minor"
  elif $HAS_PATCH; then
    BUMP_TYPE="patch"
  else
    echo "[release] No version-bumping commits touching ${PKG_PATH}. Nothing to do."
    exit 0
  fi

  MAJOR="$(echo "$CURRENT_VERSION" | cut -d. -f1)"
  MINOR="$(echo "$CURRENT_VERSION" | cut -d. -f2)"
  PATCH="$(echo "$CURRENT_VERSION" | cut -d. -f3)"
  case "$BUMP_TYPE" in
    major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    minor) NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
    patch) NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  esac

  echo "[release] Last tag: ${LAST_TAG}"
  echo "[release] Commits analyzed: ${COUNT}"
  echo "[release] Bump type: $BUMP_TYPE"
  echo "[release] Version: $CURRENT_VERSION → $NEW_VERSION"
fi

if $DRY_RUN; then
  echo "[release] Dry run - no changes made."
  exit 0
fi

NEW_TAG="${TAG_PREFIX}${NEW_VERSION}"

# Bump the manifest only when the version actually changed (skip on initial).
if [ "$NEW_VERSION" != "$CURRENT_VERSION" ]; then
  tmp="$(mktemp)"
  jq --arg v "$NEW_VERSION" '.version = $v' "$PLUGIN_JSON" > "$tmp" && mv "$tmp" "$PLUGIN_JSON"
  if ! $NO_COMMIT; then
    git add "$PLUGIN_JSON"
    git commit -m "chore(release): cc-plugin v${NEW_VERSION}"
  fi
fi

if ! $NO_TAG; then
  git tag -a "$NEW_TAG" -m "cc-plugin v${NEW_VERSION}"
  echo "[release] Tagged ${NEW_TAG}"
fi

echo "[release] Released cc-plugin v${NEW_VERSION}"
