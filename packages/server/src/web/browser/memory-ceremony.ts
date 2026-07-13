import type { UnlockedKeys } from "./memory-crypto";
import {
  applyOpened,
  filterMemories,
  KIND_MEMORY,
  type MemoryRecord,
  parsePull,
  payloadFor,
  type WireEnvelope,
} from "./memory-model";

type MemoryDependencies = {
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

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const element = <K extends keyof HTMLElementTagNameMap>(
  name: K,
  content?: string,
) => {
  const node = document.createElement(name);
  if (content !== undefined) node.textContent = content;
  return node;
};

export function registerMemoryElement(dependencies: MemoryDependencies) {
  class MemoryManager extends HTMLElement {
    #abort?: AbortController;
    #unlocked?: UnlockedKeys;
    #memories = new Map<string, MemoryRecord>();
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
      window.addEventListener("pagehide", () => this.#lock(false), { signal });
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
        if (button.dataset.action === "unlock") await this.#unlock();
        if (button.dataset.action === "sync") await this.#pull();
        if (button.dataset.action === "lock") this.#lock();
        if (button.dataset.action === "previous") {
          this.#page -= 1;
          this.#render();
        }
        if (button.dataset.action === "next") {
          this.#page += 1;
          this.#render();
        }
        if (button.dataset.action === "delete" && button.dataset.id) {
          await this.#delete(button.dataset.id);
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
      if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
      event.preventDefault();
      const submitter = event.submitter;
      if (submitter instanceof HTMLButtonElement) submitter.disabled = true;
      try {
        if (form.dataset.form === "create") await this.#create(form);
        if (form.dataset.form === "edit" && form.dataset.id) {
          await this.#edit(form.dataset.id, form);
        }
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
        )
      ) {
        return;
      }
      if (!target.matches("[data-filter]")) return;
      this.#page = 1;
      this.#render();
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
      try {
        await this.#pull();
        this.querySelector("[data-locked]")?.setAttribute("hidden", "");
        this.querySelector("[data-unlocked]")?.removeAttribute("hidden");
      } catch (error) {
        this.#lock(false);
        throw error;
      }
    }

    async #pull() {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      this.#status("Synchronizing encrypted memories…");
      const next = new Map<string, MemoryRecord>();
      let cursor = 0;
      let failures = 0;
      for (let page = 0; page < 40; page += 1) {
        const response = parsePull(
          await dependencies.json(`/v1/sync/pull?since=${cursor}&limit=500`),
          this.#orgId,
        );
        for (const envelope of response.envelopes) {
          if (envelope.kind !== KIND_MEMORY) continue;
          try {
            const payload = await dependencies.openMemoryEnvelope(
              envelope,
              this.#orgId,
              this.#unlocked.keys,
            );
            applyOpened(next, envelope, payload);
          } catch {
            failures += 1;
          }
        }
        cursor = response.nextCursor;
        if (response.envelopes.length < 500) break;
        if (page === 39) throw new Error("Memory store exceeds browser limits");
      }
      if (failures > 0) {
        this.#lock(false);
        throw new Error(
          `${failures} encrypted records failed validation; browser locked`,
        );
      }
      parsePull(
        await dependencies.json(`/v1/sync/pull?since=${cursor}&limit=1`),
        this.#orgId,
      );
      this.#memories = next;
      this.#page = 1;
      this.#render();
      this.#status(`Synchronized ${next.size} memories locally.`);
    }

    async #push(envelope: WireEnvelope) {
      const response = await dependencies.post("/v1/sync/push", {
        envelopes: [envelope],
      });
      const stale =
        typeof response === "object" &&
        response !== null &&
        Array.isArray(Reflect.get(response, "stale"))
          ? Reflect.get(response, "stale")
          : [];
      if (stale.includes(envelope.id)) {
        await this.#pull();
        throw new Error("Another edit won; memories were refreshed");
      }
      if (
        typeof response !== "object" ||
        response === null ||
        Reflect.get(response, "accepted") !== 1
      ) {
        throw new Error("Encrypted memory was not accepted");
      }
    }

    async #create(form: HTMLFormElement) {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      const data = new FormData(form);
      const content = text(data, "content");
      if (!content) throw new Error("Memory content is required");
      const now = new Date().toISOString();
      const memory: MemoryRecord = {
        id: `memory:${crypto.randomUUID()}`,
        version: 1,
        content,
        projectId: text(data, "project") || null,
        type: "fact",
        name: null,
        trigger: null,
        confidence: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.#push(
        await dependencies.sealMemoryEnvelope({
          id: memory.id,
          orgId: this.#orgId,
          version: memory.version,
          tombstone: false,
          payload: payloadFor(memory),
          unlocked: this.#unlocked,
        }),
      );
      this.#memories.set(memory.id, memory);
      form.reset();
      this.#page = 1;
      this.#render();
      this.#status("Memory encrypted and synchronized.");
    }

    async #edit(id: string, form: HTMLFormElement) {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      const current = this.#memories.get(id);
      if (!current) throw new Error("Memory no longer exists");
      const data = new FormData(form);
      const content = text(data, "content");
      if (!content) throw new Error("Memory content is required");
      const memory: MemoryRecord = {
        ...current,
        content,
        projectId: text(data, "project") || null,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.#push(
        await dependencies.sealMemoryEnvelope({
          id,
          orgId: this.#orgId,
          version: memory.version,
          tombstone: false,
          payload: payloadFor(memory),
          unlocked: this.#unlocked,
        }),
      );
      this.#memories.set(id, memory);
      this.#render();
      this.#status("Memory edit encrypted and synchronized.");
    }

    async #delete(id: string) {
      if (!this.#unlocked) throw new Error("Unlock memories first");
      const current = this.#memories.get(id);
      if (!current) throw new Error("Memory no longer exists");
      await this.#push(
        await dependencies.sealMemoryEnvelope({
          id,
          orgId: this.#orgId,
          version: current.version + 1,
          tombstone: true,
          payload: "",
          unlocked: this.#unlocked,
        }),
      );
      this.#memories.delete(id);
      this.#render();
      this.#status("Memory tombstone synchronized.");
    }

    #filters() {
      const value = (selector: string) => {
        const input = this.querySelector(selector);
        return input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement
          ? input.value
          : "";
      };
      return {
        query: value('[name="query"]'),
        project: value('[name="projectFilter"]'),
        type: value('[name="typeFilter"]'),
        page: this.#page,
      };
    }

    #render() {
      const list = this.querySelector("[data-memory-list]");
      if (!(list instanceof HTMLElement)) return;
      list.replaceChildren();
      const result = filterMemories(this.#memories.values(), this.#filters());
      this.#page = result.page;
      for (const memory of result.rows) list.append(this.#memoryNode(memory));
      if (result.rows.length === 0) {
        list.append(element("p", "No local memories match these filters."));
      }
      const count = this.querySelector("[data-memory-count]");
      if (count)
        count.textContent = `${result.total} memories · page ${result.page} of ${result.pages}`;
      const previous = this.querySelector('[data-action="previous"]');
      const next = this.querySelector('[data-action="next"]');
      if (previous instanceof HTMLButtonElement)
        previous.disabled = result.page <= 1;
      if (next instanceof HTMLButtonElement)
        next.disabled = result.page >= result.pages;
    }

    #memoryNode(memory: MemoryRecord) {
      const item = element("article");
      item.className = "item memory-item";
      const heading = element(
        "h3",
        `${memory.type}${memory.projectId ? ` · ${memory.projectId}` : ""}`,
      );
      item.append(heading, element("p", memory.content));
      const date = new Date(memory.updatedAt);
      item.append(
        element(
          "small",
          `Updated ${Number.isNaN(date.valueOf()) ? "unknown" : date.toLocaleString()}`,
        ),
      );
      const edit = element("details");
      edit.append(element("summary", "Edit locally"));
      const form = element("form");
      form.dataset.form = "edit";
      form.dataset.id = memory.id;
      form.className = "stack";
      const fieldSuffix = memory.id.replace(/[^a-zA-Z0-9_-]/g, "-");
      const content = element("textarea");
      content.id = `memory-content-${fieldSuffix}`;
      content.name = "content";
      content.required = true;
      content.maxLength = 100_000;
      content.value = memory.content;
      const contentLabel = element("label", "Memory");
      contentLabel.htmlFor = content.id;
      const project = element("input");
      project.id = `memory-project-${fieldSuffix}`;
      project.name = "project";
      project.maxLength = 256;
      project.value = memory.projectId ?? "";
      const projectLabel = element("label", "Project");
      projectLabel.htmlFor = project.id;
      const save = element("button", "Encrypt & save");
      save.type = "submit";
      form.append(contentLabel, content, projectLabel, project, save);
      edit.append(form);
      const remove = element("details");
      remove.append(element("summary", "Delete memory"));
      const confirm = element("button", "Confirm encrypted deletion");
      confirm.type = "button";
      confirm.dataset.action = "delete";
      confirm.dataset.id = memory.id;
      remove.append(confirm);
      item.append(edit, remove);
      return item;
    }

    #lock(announce = true) {
      dependencies.clearUnlocked(this.#unlocked);
      this.#unlocked = undefined;
      this.#memories.clear();
      this.#page = 1;
      this.querySelector("[data-unlocked]")?.setAttribute("hidden", "");
      this.querySelector("[data-locked]")?.removeAttribute("hidden");
      this.querySelector("[data-memory-list]")?.replaceChildren();
      for (const input of this.querySelectorAll("input, textarea")) {
        if (
          input instanceof HTMLInputElement ||
          input instanceof HTMLTextAreaElement
        ) {
          input.value = "";
        }
      }
      if (announce)
        this.#status("Locked; plaintext memories and keys were cleared.");
    }
  }

  if (!customElements.get("mimir-memory-manager")) {
    customElements.define("mimir-memory-manager", MemoryManager);
  }
}
