# About Mimir's architecture

What runs on your machine, what runs on the server, and where encryption
happens. For exactly what the server can and cannot see, read
[THREAT_MODEL.md](../THREAT_MODEL.md). To install Mimir, start at the
[README](../README.md).

```mermaid
flowchart LR
  subgraph machine["Your machine"]
    direction TB
    plugins["Editor plugin<br/>Claude Code · OpenCode · Codex CLI"]
    core["@mimir/plugin-core — shared layer"]
    brain["Memory brain<br/>extraction · hygiene · retrieval<br/>FTS + local embeddings"]
    keys["Keys<br/>X25519 keypair · org keyring<br/>device secret in the OS keychain"]
    syncmod["Sync<br/>encrypt-on-push · decrypt-on-pull<br/>(the only crypto seam)"]
    localstate[("~/.mimir<br/>org replica (SQLite + FTS)<br/>user memories · sessions<br/>cartographer index")]
    plugins --> core
    core --> brain
    core --> keys
    core --> syncmod
    brain --> localstate
    syncmod --> localstate
  end

  subgraph server["mimir-server (blind)"]
    direction TB
    auth["/api/auth<br/>accounts · orgs · invites"]
    keyroutes["/v1/keys<br/>wrapped org keys only"]
    syncroutes["/v1/sync<br/>ciphertext envelopes"]
    coord["/v1/system-prompt<br/>blind coordination"]
    tenantdb[("one SQLite file of AEAD blobs<br/>the server cannot decrypt")]
    syncroutes --> tenantdb
  end

  providers["AI providers<br/>Anthropic · OpenRouter · vLLM · Ollama · …"]

  plugins -->|"direct — your keys"| providers
  keys <-->|HTTPS| keyroutes
  syncmod <-->|HTTPS| syncroutes
```

## Your machine

Storage, embeddings, retrieval and codebase indexing all run locally, in the
shared layer every editor plugin is built on
([`plugin-core`](../packages/plugin-core/README.md)). The plugins are thin
wiring over it, so a user-facing flow never belongs to one editor.

Model calls go from your machine straight to the provider, with your own keys
or your editor's subscription. No inference transits the Mimir server.

## The server

The server has exactly four jobs:

- **Auth**: accounts, orgs, invites.
- **Wrapped-key distribution**: it stores org keys encrypted to each member's
  public key, never the keys themselves.
- **Ciphertext sync**: opaque envelopes with last-write-wins convergence.
- **Blind coordination**: the system prompt and sync leases.

It runs no models, computes no embeddings, and parses no memory content. Its
routes and configuration are in the
[server README](../packages/server/README.md).

## Where encryption happens

Encryption lives at exactly one seam: the sync module. The local replica is
plaintext, because it sits on the same disk as your code. Envelopes are sealed
on push and opened on pull.

Key material follows the 1Password shape: an X25519 keypair per user, the org
data key wrapped per member, and a device secret in the OS credential store.

The mechanics are in
[Keys and sync](../packages/plugin-core/README.md#keys-and-sync). The
guarantees are in [THREAT_MODEL.md](../THREAT_MODEL.md).
