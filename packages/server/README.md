# @mimir/server

The blind sync server. It has exactly four jobs — **auth** (accounts, orgs, invites, API keys), **wrapped-key distribution** (org keys encrypted to each member's public key), **ciphertext sync** (opaque AEAD envelopes with last-write-wins convergence), and **blind coordination** (system prompt distribution and sync leases). It runs no models, computes no embeddings, and never parses memory content or project metadata — what it can and cannot see is specified in [THREAT_MODEL.md](../../THREAT_MODEL.md).

## Surface

| Route | Job |
|-------|-----|
| `/health` | Liveness + tenant-store probe |
| `/api/auth/*` | Better Auth — accounts, orgs, invites, passkeys, API keys |
| `/v1/keys/*` | Wrapped org-key distribution: init, wrap, rotate, recovery |
| `/v1/sync/*` | Envelope push/pull, cursors, leases |
| `/v1/system-prompt` | Persona markdown for client boot |
| `/mcp` | Operator-only introspection (`read_mimir_logs`); disabled unless `MIMIR_OPERATOR_TOKEN` is set |

Storage is two SQLite files: the tenant store (`MIMIR_DB_PATH` — envelopes, sync cursors, and leases) and the auth store (`AUTH_DB_PATH`). There is no database service to operate.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `MIMIR_PORT` / `MIMIR_HOST` | `8080` / `0.0.0.0` | Bind address |
| `MIMIR_DB_PATH` | `./mimir.sqlite` | Tenant store — point at a persistent volume in deployments |
| `MIMIR_OPERATOR_TOKEN` | — | Dedicated bearer token for operator log introspection; tenant API keys are never accepted |
| `SYSTEM_PROMPT_PATH` | `./system-prompt.md` | Persona markdown served to clients |
| `AUTH_ENABLED` | `false` | Off = single-user self-hosted mode (ungated, plaintext sync); on = accounts + E2E-encrypted sync |
| `AUTH_SECRET` | — | better-auth signing secret. Required when auth is enabled; boot fails loudly without it |
| `AUTH_DB_PATH` | `./auth.sqlite` | Auth store |
| `AUTH_BASE_URL` | `http://localhost:<port>` | Public base URL — feeds better-auth and passkey rpID derivation |
| `AUTH_SETUP_TOKEN` | — | One-time first-boot claim: while zero users exist, sign-up requires `X-Setup-Token` to match |

That is the entire surface. Inference, embeddings, memory extraction, and web search all run client-side; provider keys are client configuration and never reach the server.

## Running

The Compose stack lives at the **repo root** (`docker-compose.yml` + `.env.example`), so run from there:

```bash
cp .env.example .env          # defaults work for a local single-user setup
docker compose up -d
curl http://localhost:8080/health
```

By default this **pulls** the prebuilt image (`ghcr.io/rageltd/mimir-server:next`) rather than building — see [Pulling the published image](#pulling-the-published-image) for the one-time GHCR login it needs. To compile your working tree instead, see [Building from source](#building-from-source).

With auth off (the default) the server boots ungated with a loud warning — the right shape when the operator and the only user are the same person. To run multi-user, set `AUTH_ENABLED=true` plus `AUTH_SECRET` and `AUTH_SETUP_TOKEN`, claim the first account with the setup token, and issue API keys through `/api/auth`.

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

Outside Docker, `bun run server:dev` from the repo root runs the server with `--watch`.

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

## Migration scripts

`scripts/export-projects.ts` and `scripts/import-replica.ts` are one-shot bridges from the retired SurrealDB era — they read `SOURCE_SURREAL_*` env and exist only for cutting an old instance over to the SQLite tenant store. `surrealdb` is a devDependency solely for their benefit; the runtime never touches it.
