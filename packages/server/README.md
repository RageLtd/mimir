# @mimir/server

The inference server: owns the OpenAI-compatible API, the `/mcp` endpoint, Goldfish memory, context assembly, compaction, and conversation persistence. Both the ACP adapter and the Claude Code plugin route through it.

For the full deploy walkthrough — environment variables, provider configuration, model resolution — see the [root README](../../README.md#1-deploy-the-server). This file covers running the server in Docker, including the published image and how to pull it.

## Running

The server runs in Docker alongside SurrealDB. The Compose stack lives at the **repo root** (`docker-compose.yml` + `.env.example`), so run from there:

```bash
cp .env.example .env          # set SURREAL_PASS + at least one inference provider
docker compose up -d
```

By default this **pulls** the prebuilt image (`ghcr.io/rageltd/mimir-server:next`) rather than building — see [Pulling the published image](#pulling-the-published-image) for the one-time GHCR login it needs. To compile your working tree instead, see [Building from source](#building-from-source).

## Building from source

For local development, build the image from this package's `Dockerfile` instead of pulling. Drop a gitignored `compose.override.yaml` next to the root `docker-compose.yml`:

```yaml
services:
  mimir:
    build:
      context: .
      dockerfile: packages/server/Dockerfile
```

Compose auto-merges it on every command in that directory, so `docker compose up` builds locally — no registry pull, no GHCR auth. The build uses the monorepo root as context: the Dockerfile copies the root manifest, `bun.lock`, and member `package.json` files to resolve the `catalog:` dependency graph before compiling the server binary with `bun build --compile`. The override is gitignored, so recreate it on a fresh clone whenever you want the build loop.

## Container image

CI publishes a prebuilt image to GitHub Container Registry so you don't have to build on the deploy host. The `server Image (:next)` workflow (`.github/workflows/server-image.yml`) runs on every push to `main` that touches `packages/server/**` or the workspace manifests its build depends on (`package.json`, `bun.lock`), and on manual `workflow_dispatch`. It publishes:

| Tag | Meaning |
|-----|---------|
| `ghcr.io/rageltd/mimir-server:next` | Rolling tag — overwritten by every run. Tracks the tip of `main`. |
| `ghcr.io/rageltd/mimir-server:sha-<short>` | Immutable per-commit tag. Use it to pin or roll back when `:next` moves under you. |

Images target `linux/amd64` only (the compiled binary is arch-specific). Push-side auth uses the workflow's built-in `GITHUB_TOKEN` — no secret to provision.

### Pulling the published image

The package is **private** — it contains the compiled server — so the host has to authenticate to GHCR once before `docker pull` works. There's no zero-auth way to pull a private image from any registry; the trade is a single `docker login` whose credentials Docker then caches in `~/.docker/config.json`.

**On the deploy host (recommended — a long-lived read-only token):**

1. Create a classic Personal Access Token scoped to **`read:packages` only**. This link preselects the scope: <https://github.com/settings/tokens/new?scopes=read:packages&description=mimir-server%20ghcr%20pull>. Set no expiry (or a long one) so an unattended server doesn't silently lose pull access when the token lapses.

2. Log in once. The token goes in over stdin, never as a shell-history argument:

   ```bash
   echo "$GHCR_PAT" | docker login ghcr.io -u RageLtd --password-stdin
   ```

3. Pull and start. The committed `docker-compose.yml` already points the `mimir` service at the image, so there's nothing to edit — just make sure no local `compose.override.yaml` is shadowing it with a `build:` (that's the dev-only build path):

   ```bash
   docker compose pull mimir
   docker compose up -d
   ```

That login is one-time — Docker caches it, and a non-expiring read-only token keeps pulling indefinitely with no further action.

**On a machine where `gh` is already authenticated (shortcut):**

If you just want to pull on your own workstation and already use the GitHub CLI, skip the PAT and widen your existing `gh` token instead. The default `gh` token does **not** carry `read:packages`, so add it, then hand the token to Docker:

```bash
gh auth refresh -h github.com -s read:packages
gh auth token | docker login ghcr.io -u RageLtd --password-stdin
```

Note this is convenience, not magic: `gh` is not a Docker credential helper, so Docker snapshots the token at login time. When `gh` later rotates it, the cached login goes stale and you re-run the two lines. That's why an unattended server is better served by the long-lived PAT above.
