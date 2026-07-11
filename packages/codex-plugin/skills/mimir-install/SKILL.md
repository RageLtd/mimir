---
name: mimir-install
description: Install or update Mimir for Codex — downloads the released mimir-codex binary and runs its installer, which lands the persona, lifecycle hooks, trust ledger, and MCP wiring in a dedicated CODEX_HOME (~/.mimir/codex). Use when the user asks to install Mimir, update Mimir, or fix a broken Mimir-for-Codex setup.
---

# Install or update Mimir for Codex

Codex plugins cannot deliver lifecycle hooks, so this plugin only bootstraps:
the real runtime is installed by the compiled `mimir-codex-bin` binary, fetched
from RageLtd/mimir GitHub Releases. The repo is private — the download uses the
user's own `gh` auth (any repo collaborator) or `curl` + `$GITHUB_TOKEN`.

## Fresh install

1. Download the released binary using the updater script bundled with this
   plugin. It sits at the plugin root, two directories above this skill file:
   `<plugin-root>/scripts/ensure-binary.sh`. Run:

   ```bash
   sh <plugin-root>/scripts/ensure-binary.sh codex
   ```

   This resolves the latest `codex-plugin/v*` release, downloads
   `mimir-codex-bin` for this platform to `~/.local/bin/mimir-codex-bin`, and
   re-signs it on macOS. If it fails because `gh` is missing, ask the user to
   install the GitHub CLI and run `gh auth login`, or export `GITHUB_TOKEN`.

2. Ask the user for their mimir-server URL (default: `https://mimir.rageltd.ca`),
   then run the installer:

   ```bash
   ~/.local/bin/mimir-codex-bin install <server-url>
   ```

   Useful flags: `--user-memory-db PATH`, `--cartographer PATH`,
   `--extraction-base-url URL --extraction-model MODEL` (without extraction
   config, memory distillation is off — the installer says so loudly).

3. Verify:

   ```bash
   ~/.local/bin/mimir-codex-bin status
   ```

   All hooks must show trusted. If any are untrusted, re-run
   `mimir-codex-bin update` with `codex` on PATH.

4. Tell the user to launch Mimir sessions with `mimir-codex` (make sure
   `~/.local/bin` is on PATH). Their vanilla `~/.codex` setup is untouched;
   login is shared via an auth.json symlink.

## Update

The `mimir-codex` wrapper self-updates the binary on every launch, so updates
are usually automatic. To force one:

```bash
sh ~/.mimir/ensure-binary.sh codex   # fetch the latest released binary
mimir-codex-bin update               # re-materialise CODEX_HOME artifacts + re-trust hooks
```

To refresh this skill itself: `codex plugin marketplace upgrade`.

## Dev-pin note

If `~/.mimir/.codex-dev` exists, the updater deliberately skips release checks
(a local dev build is pinned). Remove the file to resume tracking releases.
