import {
  type AdminMemoryFilters,
  filterManagedMemories,
  groupManagedMemories,
  type ManagedMemory,
} from "./admin-memory-model";
import type { WireEnvelope } from "./memory-model";

export type AdminMemoryHealth = {
  envelopes: number;
  tombstones: number;
  generationMismatches: number;
  undecryptable: number;
  conflicts: number;
  awaitingMigration: number;
};

export const emptyAdminMemoryHealth = (): AdminMemoryHealth => ({
  envelopes: 0,
  tombstones: 0,
  generationMismatches: 0,
  undecryptable: 0,
  conflicts: 0,
  awaitingMigration: 0,
});

const node = <K extends keyof HTMLElementTagNameMap>(
  name: K,
  value?: string,
) => {
  const created = document.createElement(name);
  if (value !== undefined) created.textContent = value;
  return created;
};

function memoryNode(memory: ManagedMemory, selected: Set<string>) {
  const item = node("article");
  item.className = "item memory-item";
  const label = node("label", "Select memory");
  const checkbox = node("input");
  checkbox.type = "checkbox";
  checkbox.dataset.selectId = memory.id;
  checkbox.checked = selected.has(memory.id);
  label.prepend(checkbox, " ");
  item.append(
    label,
    node(
      "h3",
      `${memory.type}${memory.projectId ? ` · ${memory.projectId}` : ""}`,
    ),
    node("p", memory.content),
    node("small", `Generation ${memory.keyGen} · ${memory.syncState}`),
  );
  const edit = node("details");
  edit.append(node("summary", "Edit locally"));
  const form = node("form");
  form.dataset.form = "edit";
  form.dataset.id = memory.id;
  form.className = "stack";
  const content = node("textarea");
  content.name = "content";
  content.required = true;
  content.maxLength = 100_000;
  content.value = memory.content;
  const contentLabel = node("label", "Memory");
  contentLabel.append(content);
  const project = node("input");
  project.name = "project";
  project.maxLength = 256;
  project.value = memory.projectId ?? "";
  const projectLabel = node("label", "Project");
  projectLabel.append(project);
  const save = node("button", "Encrypt & save");
  save.type = "submit";
  form.append(contentLabel, projectLabel, save);
  edit.append(form);
  item.append(edit);
  return item;
}

export function renderAdminMemoryList(
  root: HTMLElement,
  memories: Iterable<ManagedMemory>,
  selected: Set<string>,
  filters: AdminMemoryFilters & { groupBy: string },
) {
  const list = root.querySelector("[data-memory-list]");
  if (!(list instanceof HTMLElement)) return null;
  list.replaceChildren();
  const result = filterManagedMemories(memories, filters);
  for (const [label, groupMemories] of groupManagedMemories(
    result.rows,
    filters.groupBy,
  )) {
    const group = node("section");
    group.append(node("h3", label));
    for (const memory of groupMemories) {
      group.append(memoryNode(memory, selected));
    }
    list.append(group);
  }
  if (result.rows.length === 0) {
    list.append(node("p", "No local memories match these filters."));
  }
  const count = root.querySelector("[data-memory-count]");
  if (count) {
    count.textContent = `${result.total} records · page ${result.page} of ${result.pages}`;
  }
  const previous = root.querySelector('[data-action="previous"]');
  const next = root.querySelector('[data-action="next"]');
  if (previous instanceof HTMLButtonElement)
    previous.disabled = result.page <= 1;
  if (next instanceof HTMLButtonElement)
    next.disabled = result.page >= result.pages;
  renderAdminSelectedCount(root, selected.size);
  return result;
}

export function renderAdminSelectedCount(root: HTMLElement, selected: number) {
  const count = root.querySelector("[data-selected-count]");
  if (count) count.textContent = String(selected);
}

export function renderAdminMemoryHealth(
  root: HTMLElement,
  health: AdminMemoryHealth,
) {
  for (const [name, value] of Object.entries(health)) {
    const output = root.querySelector(`[data-health="${name}"]`);
    if (output) output.textContent = String(value);
  }
}

export function renderAdminMemoryFailures(root: HTMLElement, failures: number) {
  root
    .querySelector("[data-failures]")
    ?.toggleAttribute("hidden", failures === 0);
  const count = root.querySelector("[data-failure-count]");
  if (count) count.textContent = String(failures);
}

export function renderAdminMemoryGenerations(
  root: HTMLElement,
  envelopes: WireEnvelope[],
) {
  const select = root.querySelector('[name="generation"]');
  if (!(select instanceof HTMLSelectElement)) return;
  const current = select.value;
  select.replaceChildren(new Option("All generations", ""));
  const generations = new Set(
    envelopes.map((envelope) => envelope.keyGen).filter(Boolean),
  );
  for (const generation of [...generations].sort((a, b) => a - b)) {
    select.append(new Option(String(generation), String(generation)));
  }
  select.value = current;
}
