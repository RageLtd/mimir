import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { dashboardNavigation, PageFrame } from "./chrome";

export function renderAdminMemories(c: Context<IdentityEnv>) {
  const identity = c.get("identity");
  if (!identity) return c.text("Forbidden", 403);
  c.header("cache-control", "private, no-store");
  return c.render(
    <PageFrame
      actions={<a href="/app">Account</a>}
      navigation={dashboardNavigation(c, "organization-memories")}
    >
      <section aria-labelledby="admin-memories-title">
        <p class="kicker">Organization administration</p>
        <h1 id="admin-memories-title">Encrypted memory maintenance</h1>
        <p class="lede">
          Maintain the shared set after local unlock. The server cannot render,
          search, or moderate it, and this role-gated page does not create
          per-member cryptographic isolation.
        </p>

        <mimir-admin-memory-manager
          class="ceremony"
          data-user-id={identity.userId}
          data-org-id={identity.orgId}
        >
          <section class="card" data-locked>
            <h2>Organization memories are locked</h2>
            <p>
              Unlock with this browser's passkey. Plaintext and keys are cleared
              when the tab locks.
            </p>
            <button class="button" type="button" data-action="unlock">
              Unlock organization memories
            </button>{" "}
            <a href="/app/credentials">Manage browser enrollment</a>
            <div data-failures hidden>
              <p class="form-error">
                <span data-failure-count>0</span> records could not be opened.
              </p>
              <button type="button" data-action="retry">
                Retry all
              </button>{" "}
              <button type="button" data-action="quarantine">
                Quarantine failed records locally
              </button>
            </div>
          </section>

          <section data-unlocked hidden>
            <div class="memory-actions">
              <button type="button" data-action="sync">
                Re-sync ciphertext
              </button>
              <button type="button" data-action="export">
                Export encrypted backup
              </button>
              <button type="button" data-action="clear-quarantine">
                Retry quarantined records
              </button>
              <button type="button" data-action="lock">
                Lock
              </button>
            </div>

            <section class="card">
              <h2>Ciphertext health</h2>
              <dl class="status">
                <dt>Envelopes</dt>
                <dd data-health="envelopes">0</dd>
                <dt>Tombstones</dt>
                <dd data-health="tombstones">0</dd>
                <dt>Generation mismatches</dt>
                <dd data-health="generationMismatches">0</dd>
                <dt>Undecryptable or quarantined</dt>
                <dd data-health="undecryptable">0</dd>
                <dt>Sync conflicts</dt>
                <dd data-health="conflicts">0</dd>
                <dt>Awaiting migration</dt>
                <dd data-health="awaitingMigration">0</dd>
              </dl>
            </section>

            <section class="card memory-controls">
              <h2>Local filters</h2>
              <label>
                Search
                <input
                  name="query"
                  type="search"
                  data-filter
                  autocomplete="off"
                />
              </label>
              <label>
                Project ID
                <input name="project" data-filter autocomplete="off" />
              </label>
              <label>
                Type
                <select name="type" data-filter>
                  <option value="">All types</option>
                  <option value="fact">Fact</option>
                  <option value="summary">Summary</option>
                  <option value="playbook">Playbook</option>
                  <option value="skill">Skill</option>
                </select>
              </label>
              <label>
                Key generation
                <select name="generation" data-filter>
                  <option value="">All generations</option>
                </select>
              </label>
              <label>
                Sync state
                <select name="syncState" data-filter>
                  <option value="">All states</option>
                  <option value="synced">Synced</option>
                  <option value="conflict">Conflict</option>
                </select>
              </label>
              <label>
                Group by
                <select name="groupBy" data-filter>
                  <option value="">None</option>
                  <option value="type">Type</option>
                  <option value="project">Project</option>
                  <option value="generation">Key generation</option>
                  <option value="sync">Sync state</option>
                </select>
              </label>
            </section>

            <section class="card">
              <h2>Bulk encrypted deletion</h2>
              <p>
                Selected: <strong data-selected-count>0</strong>. Type that
                count to create authenticated tombstones.
              </p>
              <label>
                Confirmation count{" "}
                <input
                  name="confirmCount"
                  type="number"
                  min="1"
                  autocomplete="off"
                />
              </label>{" "}
              <button type="button" data-action="bulk-delete">
                Create selected tombstones
              </button>
            </section>

            <section>
              <h2>Decrypted in this tab</h2>
              <p class="muted" data-memory-count />
              <div class="items" data-memory-list />
              <nav class="memory-pages" aria-label="Memory pages">
                <button type="button" data-action="previous">
                  Previous
                </button>
                <button type="button" data-action="next">
                  Next
                </button>
              </nav>
            </section>
          </section>

          <p role="status" aria-live="polite">
            No organization memory plaintext has been requested.
          </p>
          <noscript>
            <p class="notice">
              The server cannot render encrypted organization memories. Local
              JavaScript and passkey unlock are required.
            </p>
          </noscript>
        </mimir-admin-memory-manager>
      </section>
    </PageFrame>,
    {
      title: "Encrypted memory maintenance — Mimir",
      description: "Maintain locally decrypted organization memories.",
      scripts: ["/assets/admin-memories.js"],
      styles: ["dashboard", "card", "lists", "status", "ceremony", "memory"],
    },
  );
}
