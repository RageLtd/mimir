# Security Best-Practices Review

## Executive summary

Mimir's strongest controls are real: authentication defaults closed when enabled, tenant data access is scoped by resolved organization identity, SQL values are parameterized, browser-rendered memory content uses `textContent`, envelope v2 authenticates record identity, version, and deletion intent, and secret redaction is centralized. Two high-priority findings were remediated during this review: current clients no longer send project metadata to the server, and global logs now require a separate operator credential. Existing deployments still need their retired plaintext project rows purged. Client releases remain neither publisher-signed nor verified. The web dashboard also lacks framing and CSP protections, while some authenticated JSON surfaces and the server timeout posture need further hardening.

This review applies the installed vanilla browser JavaScript/TypeScript guidance directly. The installed backend reference targets Express rather than Hono, so only framework-independent server rules were applied; Hono's current official CORS and secure-header documentation was checked separately.

## High severity

### SBP-001 — Plaintext project metadata contradicts the operator-blind trust claim

**Status:** Remediated for current traffic; destructive legacy-row purge still required per deployment.

- **Rule:** Data minimization and evidence-backed security claims
- **Location:** `packages/plugin-core/src/project/resolver.ts`, `packages/plugin-core/src/project/index.ts`, `packages/server/src/app.ts`, `packages/server/src/db/tenant.ts`
- **Evidence:** Project IDs now derive locally from a normalized git remote or local-path fallback. `/v1/projects` is no longer mounted, and manifest metadata refresh calls were removed. The legacy SQLite table remains so old deployments can be purged deliberately rather than by an implicit destructive migration.
- **Impact:** The operator or a server compromise can read repository identity, local filesystem layout, stack, and project descriptions. That does not expose encrypted memories, but it is tenant-derived content and makes the unqualified “server operator can never read your data” and “blind coordination” claims inaccurate.
- **Fix:** Completed for new traffic. Purge the retired `project` rows in each upgraded tenant database after confirming the deployment is on clients that derive local IDs.
- **Mitigation:** Stop sending manifest descriptions and absolute paths; send a client-generated opaque project ID and, if necessary, a keyed digest used only for lookup.
- **False-positive notes:** An empty legacy table is harmless; populated rows are still readable to the operator and keep this finding open for that deployment.

### SBP-002 — Authenticated tenants can read global, cross-tenant server logs

**Status:** Remediated in code.

- **Rule:** Authorization must match the resource scope
- **Location:** `packages/server/src/middleware/operator.ts`, `packages/server/src/app.ts`, `packages/server/src/routes/mcp.ts`
- **Evidence:** `/mcp` is intercepted before tenant identity resolution. It requires `Authorization: Bearer <MIMIR_OPERATOR_TOKEN>`, returns 404 when that secret is unset, and rejects ordinary Better Auth tenant credentials.
- **Impact:** A valid user or API key in one organization can inspect operational metadata belonging to every organization. Depending on logged errors, this can include repository remotes, absolute paths, project metadata, and other details that violate the stated cross-tenant boundary.
- **Fix:** Completed with a distinct operator authorization boundary. Provision and rotate the operator token separately from tenant API keys.
- **Mitigation:** Stop logging request bodies and path-bearing client metadata, extend redaction beyond provider keys, and return a bounded health/diagnostic summary instead of raw lines.
- **False-positive notes:** Deployment configuration must set the token for operator use; leaving it unset safely disables the endpoint.

### SBP-003 — Client release authenticity is claimed but not implemented

- **Rule:** Supply-chain integrity and dependency pinning
- **Location:** `THREAT_MODEL.md:43`, `THREAT_MODEL.md:211`, `.github/workflows/cc-plugin-release.yml:88`, `.github/workflows/cc-plugin-release.yml:119`, `packages/plugin-core/scripts/ensure-binary.sh:132`, `packages/plugin-core/scripts/ensure-binary.sh:149`, `packages/plugin-core/scripts/ensure-binary.sh:166`
- **Evidence:** Release workflows publish binaries without checksums, attestations, or a publisher signature. The updater downloads the release asset directly into the executable path and performs no digest or signature verification. macOS then receives an ad-hoc local signature, which proves neither publisher identity nor artifact integrity. Workflow actions use mutable major tags and release builds use `bun-version: latest`.
- **Impact:** A compromised repository, workflow dependency, Actions token, or release asset can distribute a client that reads plaintext memories, source code, key material, and provider credentials. This is the universal E2E failure mode the threat model explicitly relies on release signing to mitigate.
- **Fix:** Produce immutable artifact digests and Sigstore/GitHub artifact attestations in the release workflow, verify them before replacing the installed binary, and update the version marker only after verification. Pin third-party actions and the Bun toolchain to immutable versions or commit SHAs.
- **Mitigation:** Download into a temporary file, verify size and digest, atomically rename it into place, and retain the last verified binary for rollback.
- **False-positive notes:** GitHub authentication and private-repository access protect transport and authorization, but they are not an end-to-end publisher signature. Ad-hoc `codesign -` is not identity-bearing signing.

## Medium severity

### SBP-004 — Dashboard responses lack CSP and anti-framing controls

- **Rule:** JS-CSP-001, JS-CSP-002, clickjacking defense
- **Location:** `packages/server/src/app.ts:41`, `packages/server/src/web/chrome.tsx:23`
- **Evidence:** The app installs only global CORS middleware. No `Content-Security-Policy`, `frame-ancestors`, `X-Frame-Options`, or `X-Content-Type-Options` policy is visible in application or repository edge configuration. The dashboard executes same-origin module scripts and renders an inline style block.
- **Impact:** The credentials dashboard can be framed for clickjacking, and a future HTML injection bug has no CSP containment. Credential-management forms use exact Origin checks, but a same-origin document loaded inside an attacker's frame still submits with the application's own origin.
- **Fix:** Install Hono's `secureHeaders` middleware before routes. Use at least `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, and `connect-src 'self'`; permit the current inline CSS deliberately or move it to a same-origin stylesheet.
- **Mitigation:** Set equivalent headers at the trusted edge and verify them with a runtime response test.
- **False-positive notes:** Railway or Caddy may inject headers outside the repository. Verify the deployed response before closing the finding; no such configuration is visible here.

### SBP-005 — Request and encrypted-field bounds are incomplete

**Status:** Partially remediated for sync envelopes.

- **Rule:** Input validation and request-body limits
- **Location:** `packages/server/src/routes/sync.ts:50`, `packages/server/src/routes/sync.ts:130`, `packages/server/src/routes/keys.ts:51`, `packages/server/src/routes/mcp.ts:134`, `packages/server/src/web/forms.ts:15`
- **Evidence:** Sync now caps IDs, nonces, payloads, batches, key generations, and versions; requires safe integers, base64url wire encoding, closed versions/suites/kinds, and suite-specific tombstone shapes. Wrapped-key routes, MCP JSON shape, aggregate request-body limits, and chunked form limits still require work.
- **Impact:** An authenticated user can consume memory and disk with oversized ciphertext/wrap values or poison the organization's sync stream with unsupported metadata that causes clients to fail closed. Public auth forms and MCP parsing retain a broader body-DoS surface than the declared limits suggest.
- **Fix:** Enforce a transport-level body limit, then validate exact schemas and maximum encoded lengths at every route. Pin envelope version, suite, kind, nonce length, tombstone shape, safe integer ranges, ID length, wrap size, lease-name length, and aggregate batch bytes before opening a transaction.
- **Mitigation:** Add reverse-proxy body limits and per-identity storage quotas.
- **False-positive notes:** Bun has a runtime request-body ceiling, but the application does not set a project-specific bound and encrypted rows can still be oversized well below a runtime maximum.

### SBP-006 — Public-server timeout posture is intentionally disabled using a stale rationale

- **Rule:** Server DoS protections
- **Location:** `packages/server/src/index.ts:78`
- **Evidence:** `Bun.serve` sets `idleTimeout: 0`; the adjacent comment cites Ollama cold starts and long generations even though the same file states inference has moved entirely client-side.
- **Impact:** A directly reachable server can hold connections indefinitely and amplify Slowloris/resource-exhaustion attacks. The risk is lower if a trusted proxy enforces strict upstream timeouts and connection limits.
- **Fix:** Restore a bounded application idle timeout suitable for auth, sync, and dashboard requests. Treat long operations, if any remain, with route-specific asynchronous designs rather than disabling the server-wide limit.
- **Mitigation:** Enforce request, header, connection, and upstream-response timeouts at Railway/Caddy and monitor active connection counts.
- **False-positive notes:** This becomes low severity if every deployment is behind a correctly configured proxy with shorter enforced timeouts.

## Low severity

### SBP-007 — Global wildcard CORS is broader than the application needs

- **Rule:** Explicit least-privilege CORS
- **Location:** `packages/server/src/app.ts:41`
- **Evidence:** Hono's default `cors()` sets `Access-Control-Allow-Origin: *` and broadly allows common methods. The dashboard and machine clients are same-origin or non-browser clients, so no repository requirement for global browser cross-origin access is evident.
- **Impact:** Current impact is limited because credentials are not enabled and custom request headers are not allowed by default, but the middleware creates an easy future foot-gun as browser API surfaces evolve.
- **Fix:** Remove CORS unless a browser client requires it, or scope it to explicit routes, origins, methods, and headers.
- **Mitigation:** Add response tests that assert credentialed wildcard CORS can never be enabled.
- **False-positive notes:** If an external browser integration exists, document its exact origins and required headers and encode only those.

### SBP-008 — Key fallback files and browser secrets need tighter lifecycle hardening

- **Rule:** Secret storage and minimum exposure
- **Location:** `packages/plugin-core/src/keys/device-secret.ts:117`, `packages/server/src/web/browser/credential-ceremony.ts:49`, `packages/server/src/web/browser/credential-ceremony.ts:164`
- **Evidence:** The passphrase-encrypted fallback is written without explicitly enforcing owner-only permissions or atomic replacement. The browser credential ceremony clears the displayed and in-memory device secret on explicit lock or disconnect, but unlike the memory manager it has no `pagehide` lock; back-forward cache can preserve the component and secret.
- **Impact:** Local users may read the encrypted fallback blob, interrupted writes can corrupt the only local copy, and browser navigation may retain plaintext key material longer than intended. Encryption and WebAuthn wrapping substantially limit the practical impact.
- **Fix:** Create and replace the fallback file atomically with mode `0600`, validate permissions when reading, and clear browser secret buffers, inputs, and output on `pagehide` as well as disconnect.
- **Mitigation:** Document that the encrypted file is a fallback rather than a substitute for filesystem permissions, and add lifecycle tests covering back-forward cache navigation.
- **False-positive notes:** A restrictive process umask may already produce `0600`, but the code does not enforce or test that invariant.

### SBP-009 — The public health endpoint returns raw storage error messages

- **Rule:** Production error responses should be generic
- **Location:** `packages/server/src/app.ts:77`
- **Evidence:** `/health` is deliberately unauthenticated and includes `err.message` in the JSON response when SQLite fails.
- **Impact:** Filesystem paths, SQLite details, or deployment internals may be disclosed during failures.
- **Fix:** Log the detailed error server-side and return only `status: "down"` publicly.
- **Mitigation:** Restrict detailed health diagnostics to operator-only telemetry.
- **False-positive notes:** Some operators intentionally expose detailed health output on private networks; the default bind address and cloud deployment make that assumption unsafe without an edge restriction.

## Existing controls worth preserving

- The identity gate normalizes cookies and API keys into one Better Auth lookup and requires an active or sole organization before setting request scope (`packages/server/src/middleware/identity.ts:135`, `packages/server/src/middleware/identity.ts:152`).
- Signup is claim-token or invitation-only and uses constant-time token comparison (`packages/server/src/auth/claim.ts:30`, `packages/server/src/auth/claim.ts:47`).
- Credential forms have bounded fields, generic failures, exact Origin checks, and one-time API-key display (`packages/server/src/web/forms.ts:15`, `packages/server/src/web/credential-actions.ts:61`).
- Server SQL uses bound parameters throughout the reviewed auth, key, and sync paths.
- Envelope v2 authenticates record versions and tombstones, encrypted deletions carry AEAD tags, equal-version replacement is refused, and established replicas reject lower-version replay.
- Browser memory rendering builds elements and assigns `textContent`; no attacker-controlled `innerHTML`, dynamic code execution, unsafe navigation, or third-party script execution was found (`packages/server/src/web/browser/memory-ceremony.ts:37`).
- The browser stores only a WebAuthn-PRF-wrapped device secret envelope in `localStorage`, validates its shape on read, and keeps plaintext memory/key state in process memory (`packages/server/src/web/browser/credential-ceremony.ts:155`, `packages/server/src/web/browser/memory-crypto.ts:37`).
- Provider/API-key redaction is centralized and tested (`packages/server/src/util/redact.ts:13`).

## Recommended order

Purge the legacy project rows to finish SBP-001 operationally and provision the separate operator token for SBP-002. Then close SBP-003 before broad client distribution, because the E2E design ultimately trusts shipped client code. SBP-004 through SBP-006 form the public-dashboard hardening pass; the low findings can ride alongside those changes.
