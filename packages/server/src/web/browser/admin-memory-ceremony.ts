import {
  awaitsMigration,
  type ManagedMemory,
  managedMemory,
  parseAdminPull,
  parseMaintenanceResult,
} from "./admin-memory-model";
import {
  type AdminMemoryHealth,
  emptyAdminMemoryHealth,
  renderAdminMemoryFailures,
  renderAdminMemoryGenerations,
  renderAdminMemoryHealth,
  renderAdminMemoryList,
  renderAdminSelectedCount,
} from "./admin-memory-view";
import type { UnlockedKeys } from "./memory-crypto";
import { payloadFor, type WireEnvelope } from "./memory-model";

type AdminMemoryDependencies = {
  json: (path: string, init?: RequestInit) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  unlockKeys: (userId: string) => Promise<UnlockedKeys>;
  clearUnlocked: (unlocked: UnlockedKeys | undefined) => void;
  openMemoryEnvelope: (
    envelope: WireEnvelope,
    orgId: string,
    keys: Map<number, Uint8Array>,
  ) => Promise<string | null>;
  sealMemoryEnvelope: (input: {
    id: string;
    orgId: string;
    version: number;
    tombstone: boolean;
    payload: string;
    unlocked: UnlockedKeys;
  }) => Promise<WireEnvelope>;
};

const formText = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export function registerAdminMemoryElement(
  dependencies: AdminMemoryDependencies,
) {
  class AdminMemoryManager extends HTMLElement {
    #abort?: AbortController;
    #unlocked?: UnlockedKeys;
    #memories = new Map<string, ManagedMemory>();
    #envelopes: WireEnvelope[] = [];
    #selected = new Set<string>();
    #conflicts = new Set<string>();
    #failed = new Set<string>();
    #quarantined = new Set<string>();
    #health: AdminMemoryHealth = emptyAdminMemoryHealth();
    #page = 1;

    connectedCallback() {
      this.#abort?.abort();
      this.#abort = new AbortController();
      const signal = this.#abort.signal;
      this.addEventListener("click", (event) => this.#clicked(event), {
        signal,
      });
      this.addEventListener("submit", (event) => this.#submitted(event), {
        signal,
      });
      this.addEventListener("input", (event) => this.#filtered(event), {
        signal,
      });
      this.addEventListener(
        "change",
        (event) => this.#selectionChanged(event),
        {
          signal,
        },
      );
      window.addEventListener("pagehide", () => this.#lock(false), { signal });
      window.addEventListener("offline", () => this.#lock(false), { signal });
    }

    disconnectedCallback() {
      this.#abort?.abort();
      this.#lock(false);
    }

    get #userId() {
      if (!this.dataset.userId) throw new Error("User identity is unavailable");
      return this.dataset.userId;
    }

    get #orgId() {
      if (!this.dataset.orgId) {
        throw new Error("Organization identity is unavailable");
      }
      return this.dataset.orgId;
    }

    async #clicked(event: Event) {
      const button = event.target;
      if (!(button instanceof HTMLButtonElement) || !button.dataset.action) {
        return;
      }
      event.preventDefault();
      button.disabled = true;
      try {
        const action = button.dataset.action;
        if (action === "unlock" || action === "retry") await this.#unlock();
        if (action === "sync") await this.#synchronize();
        if (action === "lock") this.#lock();
        if (action === "export") this.#export();
        if (action === "bulk-delete") await this.#bulkDelete();
        if (action === "quarantine") await this.#quarantineFailed();
        if (action === "clear-quarantine") await this.#clearQuarantine();
        if (action === "previous") {
          this.#page -= 1;
          this.#render();
        }
        if (action === "next") {
          this.#page += 1;
          this.#render();
        }
      } catch (error) {
        this.#status(
          error instanceof Error ? error.message : "Memory operation failed",
          true,
        );
      } finally {
        button.disabled = false;
      }
    }

    async #submitted(event: SubmitEvent) {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form.dataset.form !== "edit") {
        return;
      }
      event.preventDefault();
      const submitter = event.submitter;
      if (submitter instanceof HTMLButtonElement) submitter.disabled = true;
      try {
        if (!form.dataset.id) throw new Error("Memory no longer exists");
        await this.#edit(form.dataset.id, form);
      } catch (error) {
        this.#status(
          error instanceof Error ? error.message : "Memory operation failed",
          true,
        );
      } finally {
        if (submitter instanceof HTMLButtonElement) submitter.disabled = false;
      }
    }

    #filtered(event: Event) {
      const target = event.target;
      if (
        !(
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement
        ) ||
        !target.matches("[data-filter]")
      ) {
        return;
      }
      this.#page = 1;
      this.#render();
    }

    #selectionChanged(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.selectId) {
        return;
      }
      target.checked
        ? this.#selected.add(target.dataset.selectId)
        : this.#selected.delete(target.dataset.selectId);
      renderAdminSelectedCount(this, this.#selected.size);
    }

    #status(message: string, error = false) {
      const status = this.querySelector("[role=status]");
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("form-error", error);
    }

    async #unlock() {
      this.#status("Waiting for your passkey…");
      const unlocked = await dependencies.unlockKeys(this.#userId);
      dependencies.clearUnlocked(this.#unlocked);
      this.#unlocked = unlocked;
      await this.#synchronize();
      this.querySelector("[data-locked]")?.setAttribute("hidden", "");
      this.querySelector("[data-unlocked]")?.removeAttribute("hidden");
    }

    async #synchronize() {
      try {
        await this.#pull();
      } catch {
        this.#lock(false, true);
        throw new Error("Encrypted memory validation failed; browser locked");
      }
    }

    async #pull() {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      this.#status("Synchronizing encrypted organization memories…");
      const memories = new Map<string, ManagedMemory>();
      const envelopes: WireEnvelope[] = [];
      const failures = new Set<string>();
      const health = emptyAdminMemoryHealth();
      health.conflicts = this.#conflicts.size;
      let cursor = 0;
      for (let page = 0; page < 40; page += 1) {
        const response = parseAdminPull(
          await dependencies.json(`/v1/sync/pull?since=${cursor}&limit=500`),
          this.#orgId,
        );
        for (const envelope of response.envelopes) {
          envelopes.push(envelope);
          health.envelopes += 1;
          if (envelope.tombstone) health.tombstones += 1;
          if (awaitsMigration(envelope)) {
            health.awaitingMigration += 1;
            continue;
          }
          if (envelope.keyGen !== this.#unlocked.generation) {
            health.generationMismatches += 1;
          }
          if (this.#quarantined.has(envelope.id)) {
            health.undecryptable += 1;
            continue;
          }
          try {
            const payload = await dependencies.openMemoryEnvelope(
              envelope,
              this.#orgId,
              this.#unlocked.keys,
            );
            if (!envelope.tombstone && payload !== null) {
              memories.set(
                envelope.id,
                managedMemory(
                  envelope,
                  payload,
                  this.#conflicts.has(envelope.id),
                ),
              );
            }
          } catch {
            failures.add(envelope.id);
          }
        }
        cursor = response.nextCursor;
        if (response.envelopes.length < 500) break;
        if (page === 39) throw new Error("Memory store exceeds browser limits");
      }
      health.undecryptable += failures.size;
      this.#health = health;
      this.#failed = failures;
      renderAdminMemoryHealth(this, this.#health);
      renderAdminMemoryFailures(this, this.#failed.size);
      if (failures.size > 0)
        throw new Error("Encrypted memory validation failed");
      this.#memories = memories;
      this.#envelopes = envelopes;
      this.#selected = new Set(
        [...this.#selected].filter((id) => memories.has(id)),
      );
      this.#page = 1;
      renderAdminMemoryGenerations(this, this.#envelopes);
      this.#render();
      this.#status(`Synchronized ${memories.size} decrypted records locally.`);
    }

    async #push(envelopes: WireEnvelope[]) {
      let response: unknown;
      try {
        response = await dependencies.post("/admin/memories/maintenance", {
          envelopes,
        });
      } catch {
        this.#lock(false, true);
        throw new Error("Encrypted maintenance request failed; browser locked");
      }
      const result = parseMaintenanceResult(response, envelopes.length);
      if (!result) {
        this.#lock(false, true);
        throw new Error("Encrypted maintenance response failed validation");
      }
      if (result.complete) return;
      for (const id of result.stale) this.#conflicts.add(id);
      this.#health.conflicts = this.#conflicts.size;
      await this.#synchronize();
      throw new Error("Some records changed elsewhere; local view refreshed");
    }

    async #edit(id: string, form: HTMLFormElement) {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      const current = this.#memories.get(id);
      if (!current) throw new Error("Memory no longer exists");
      const data = new FormData(form);
      const content = formText(data, "content");
      if (!content) throw new Error("Memory content is required");
      const updated: ManagedMemory = {
        ...current,
        content,
        projectId: formText(data, "project") || null,
        keyGen: this.#unlocked.generation,
        version: current.version + 1,
        syncState: "synced",
        updatedAt: new Date().toISOString(),
      };
      const envelope = await dependencies.sealMemoryEnvelope({
        id,
        orgId: this.#orgId,
        version: updated.version,
        tombstone: false,
        payload: payloadFor(updated),
        unlocked: this.#unlocked,
      });
      await this.#push([envelope]);
      this.#conflicts.delete(id);
      await this.#synchronize();
      this.#status("Memory edit encrypted, synchronized, and audited.");
    }

    async #bulkDelete() {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      const unlocked = this.#unlocked;
      const ids = [...this.#selected].filter((id) => this.#memories.has(id));
      const input = this.querySelector('[name="confirmCount"]');
      const confirmed =
        input instanceof HTMLInputElement ? Number(input.value) : 0;
      if (ids.length === 0 || confirmed !== ids.length) {
        throw new Error("Confirmation count must exactly match the selection");
      }
      const envelopes = await Promise.all(
        ids.map((id) => {
          const current = this.#memories.get(id);
          if (!current) throw new Error("Memory no longer exists");
          return dependencies.sealMemoryEnvelope({
            id,
            orgId: this.#orgId,
            version: current.version + 1,
            tombstone: true,
            payload: "",
            unlocked,
          });
        }),
      );
      await this.#push(envelopes);
      for (const id of ids) this.#conflicts.delete(id);
      this.#selected.clear();
      if (input instanceof HTMLInputElement) input.value = "";
      await this.#synchronize();
      this.#status(
        `${ids.length} authenticated tombstones synchronized and audited.`,
      );
    }

    #export() {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      const backup = JSON.stringify({
        format: "mimir-encrypted-memory-backup",
        version: 1,
        orgId: this.#orgId,
        exportedAt: new Date().toISOString(),
        envelopes: this.#envelopes,
      });
      const url = URL.createObjectURL(
        new Blob([backup], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "mimir-encrypted-memory-backup.json";
      link.click();
      URL.revokeObjectURL(url);
      this.#status("Encrypted backup exported locally.");
    }

    async #quarantineFailed() {
      for (const id of this.#failed) this.#quarantined.add(id);
      this.#failed.clear();
      await this.#unlock();
    }

    async #clearQuarantine() {
      this.#quarantined.clear();
      await this.#synchronize();
    }

    #value(name: string) {
      const field = this.querySelector(`[name="${name}"]`);
      return field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement
        ? field.value
        : "";
    }

    #render() {
      const result = renderAdminMemoryList(
        this,
        this.#memories.values(),
        this.#selected,
        {
          query: this.#value("query"),
          project: this.#value("project"),
          type: this.#value("type"),
          generation: this.#value("generation"),
          syncState: this.#value("syncState"),
          page: this.#page,
          groupBy: this.#value("groupBy"),
        },
      );
      if (result) this.#page = result.page;
    }

    #lock(announce = true, preserveHealth = false) {
      dependencies.clearUnlocked(this.#unlocked);
      this.#unlocked = undefined;
      this.#memories.clear();
      this.#envelopes = [];
      this.#selected.clear();
      this.#page = 1;
      if (!preserveHealth) this.#health = emptyAdminMemoryHealth();
      this.querySelector("[data-unlocked]")?.setAttribute("hidden", "");
      this.querySelector("[data-locked]")?.removeAttribute("hidden");
      this.querySelector("[data-memory-list]")?.replaceChildren();
      for (const input of this.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea")) {
        input.value = "";
      }
      renderAdminMemoryHealth(this, this.#health);
      renderAdminMemoryFailures(this, this.#failed.size);
      if (announce) {
        this.#status(
          "Locked; plaintext memories, drafts, queries, and keys were cleared.",
        );
      }
    }
  }

  if (!customElements.get("mimir-admin-memory-manager")) {
    customElements.define("mimir-admin-memory-manager", AdminMemoryManager);
  }
}
