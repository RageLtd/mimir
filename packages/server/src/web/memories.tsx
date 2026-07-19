import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { dashboardNavigation, PageFrame } from "./chrome";

export function renderMemories(c: Context<IdentityEnv>) {
  const identity = c.get("identity");
  c.header("cache-control", "private, no-store");
  return c.render(
    <PageFrame
      actions={<a href="/app">Account</a>}
      navigation={dashboardNavigation(c, "memories")}
    >
      <section aria-labelledby="memories-title">
        <p class="kicker">Private context</p>
        <h1 id="memories-title">Memories</h1>
        <p class="lede">
          Search and edit locally decrypted organization context. The server
          stores ciphertext only.
        </p>
        <mimir-memory-manager
          class="ceremony"
          data-user-id={identity?.userId}
          data-org-id={identity?.orgId}
        >
          <section class="card" data-locked aria-labelledby="unlock-title">
            <h2 id="unlock-title">Memories are locked</h2>
            <p>
              Unlock with the browser passkey enrolled on the Credentials page.
              Decryption and search happen only in this browser.
            </p>
            <button class="button" type="button" data-action="unlock">
              Unlock memories
            </button>{" "}
            <a href="/app/credentials">Manage browser enrollment</a>
          </section>

          <section data-unlocked hidden>
            <div class="memory-actions">
              <button type="button" data-action="sync">
                Sync ciphertext
              </button>
              <button type="button" data-action="lock">
                Lock
              </button>
            </div>

            <section
              class="card memory-controls"
              aria-labelledby="filter-title"
            >
              <h2 id="filter-title">Local filters</h2>
              <label for="memory-query">Search plaintext locally</label>
              <input
                id="memory-query"
                name="query"
                type="search"
                data-filter
                autocomplete="off"
              />
              <label for="memory-project-filter">Project ID</label>
              <input
                id="memory-project-filter"
                name="projectFilter"
                data-filter
                autocomplete="off"
              />
              <label for="memory-type-filter">Type</label>
              <select id="memory-type-filter" name="typeFilter" data-filter>
                <option value="">All types</option>
                <option value="fact">Fact</option>
                <option value="summary">Summary</option>
                <option value="playbook">Playbook</option>
                <option value="skill">Skill</option>
              </select>
            </section>

            <section class="card" aria-labelledby="create-memory-title">
              <h2 id="create-memory-title">New memory</h2>
              <form class="stack" data-form="create">
                <label for="new-memory-content">Memory</label>
                <textarea
                  id="new-memory-content"
                  name="content"
                  maxlength={100_000}
                  required
                />
                <label for="new-memory-project">Project ID</label>
                <input id="new-memory-project" name="project" maxlength={256} />
                <button class="button" type="submit">
                  Encrypt &amp; save
                </button>
              </form>
            </section>

            <section aria-labelledby="memory-list-title">
              <h2 id="memory-list-title">Decrypted in this tab</h2>
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
            No memory plaintext has been requested.
          </p>
          <noscript>
            <p class="notice">
              Encrypted memory content requires local browser unlock. The server
              cannot render or search it for you.
            </p>
          </noscript>
        </mimir-memory-manager>
      </section>
    </PageFrame>,
    {
      title: "Memories — Mimir",
      description: "Manage locally decrypted organization memories.",
      scripts: ["/assets/memories.js"],
      styles: ["dashboard", "card", "forms", "lists", "ceremony", "memory"],
    },
  );
}
