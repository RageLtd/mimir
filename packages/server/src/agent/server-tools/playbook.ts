/**
 * Playbook management tools (skill-parity layer).
 *
 * A playbook is a learned, reusable procedure stored as a type="playbook"
 * memory with structured `name` + `trigger` fields. These tools are the full
 * lifecycle — store, list, load, update, delete — and are registered both as
 * server tools and as public /mcp tools so Claude Code drives the same library.
 *
 * Discovery and ambient body-loading happen automatically via the injected
 * playbook index + trigger match (see goldfish/playbook.ts); these tools cover
 * authoring and deliberate fetch.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
} from "../../goldfish/playbook";
import { deleteMemory } from "../../goldfish/store";
import { log } from "../../util/logger";
import { storeTypedMemory } from "./memory";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PlaybookStoreSchema = z.object({
  name: z
    .string()
    .describe(
      "Short label for the playbook — how it appears in the always-present index (e.g. 'Railway env var audit'). Keep it a few words.",
    ),
  trigger: z
    .string()
    .describe(
      "The 'use this when…' line describing WHEN the playbook applies (e.g. 'use when auditing or listing Railway environment variables'). Written to match a task description — this is the embedding key that decides when the body is auto-loaded, so describe the situation, not the steps.",
    ),
  content: z
    .string()
    .describe(
      "The playbook body — the steps, checks, sequence, and gotchas for the task. Write it so a future session facing this situation could follow it.",
    ),
  project: z
    .string()
    .optional()
    .describe(
      "Optional project identifier (UUID, path, or git remote) when the procedure is specific to one repo. Omit for a fully generic playbook usable everywhere. Resolved to canonical UUID before storing.",
    ),
});

const PlaybookListSchema = z.object({
  project: z
    .string()
    .optional()
    .describe(
      "Optional project identifier to scope the listing to that project + global playbooks. Omit to list every playbook.",
    ),
});

const PlaybookSelectorSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Playbook name to act on (as shown in the index/list)."),
  id: z
    .string()
    .optional()
    .describe("Playbook memory id (e.g. 'memory:abc123'), if known."),
});

const PlaybookUpdateSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Name of the playbook to update (selector)."),
  id: z
    .string()
    .optional()
    .describe("Memory id of the playbook to update (selector, if known)."),
  newName: z
    .string()
    .optional()
    .describe("New name. Re-embeds the trigger when changed."),
  trigger: z
    .string()
    .optional()
    .describe("New trigger line. Re-embeds so ambient matching tracks it."),
  content: z.string().optional().describe("New body."),
});

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

export const executePlaybookStore = ({
  name,
  trigger,
  content,
  project,
}: z.infer<typeof PlaybookStoreSchema>) =>
  storeTypedMemory({ content, project, type: "playbook", name, trigger });

export const executePlaybookList = async ({
  project,
}: z.infer<typeof PlaybookListSchema>) => {
  const playbooks = await listPlaybooks(project);
  log.info(
    { count: playbooks.length, project: project ?? "all" },
    "project_playbook_list",
  );
  return {
    playbooks: playbooks.map((p) => ({
      id: p.id,
      name: p.name ?? null,
      trigger: p.trigger ?? null,
      project_id: p.project_id ?? null,
    })),
    error: null,
  };
};

export const executePlaybookLoad = async ({
  name,
  id,
}: z.infer<typeof PlaybookSelectorSchema>) => {
  if (!name && !id) {
    return { found: false, error: "Provide a playbook name or id" };
  }
  const playbook = await getPlaybook({ id, name });
  if (!playbook) {
    return { found: false, error: `Playbook not found: ${name ?? id}` };
  }
  log.info({ id: playbook.id, name: playbook.name }, "project_playbook_load");
  return {
    found: true,
    id: playbook.id,
    name: playbook.name ?? null,
    trigger: playbook.trigger ?? null,
    content: playbook.content,
    project_id: playbook.project_id ?? null,
    error: null,
  };
};

export const executePlaybookUpdate = async ({
  name,
  id,
  newName,
  trigger,
  content,
}: z.infer<typeof PlaybookUpdateSchema>) => {
  if (!name && !id) {
    return { updated: false, error: "Provide a playbook name or id to update" };
  }
  if (newName === undefined && trigger === undefined && content === undefined) {
    return {
      updated: false,
      error: "Nothing to update — provide newName, trigger, or content",
    };
  }
  const target = await getPlaybook({ id, name });
  if (!target) {
    return { updated: false, error: `Playbook not found: ${name ?? id}` };
  }
  const result = await updatePlaybook(target.id, {
    name: newName,
    trigger,
    content,
  });
  if (!result) {
    return { updated: false, error: "Failed to update playbook" };
  }
  log.info({ id: result.id, name: result.name }, "project_playbook_update");
  return {
    updated: true,
    id: result.id,
    name: result.name ?? null,
    error: null,
  };
};

export const executePlaybookDelete = async ({
  name,
  id,
}: z.infer<typeof PlaybookSelectorSchema>) => {
  if (!name && !id) {
    return { deleted: false, error: "Provide a playbook name or id to delete" };
  }
  const target = await getPlaybook({ id, name });
  if (!target) {
    return { deleted: false, error: `Playbook not found: ${name ?? id}` };
  }
  const deleted = await deleteMemory(target.id);
  log.info(
    { id: target.id, name: target.name, deleted },
    "project_playbook_delete",
  );
  return {
    deleted,
    id: target.id,
    name: target.name ?? null,
    error: deleted ? null : `Failed to delete: ${target.id}`,
  };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const playbookTools = {
  project_playbook_store: tool({
    description:
      "Persist a learned, reusable playbook — the procedure for a recurring KIND of task — so future sessions follow it instead of rediscovering it. Authoring a playbook is like writing a skill file: give it a name, a 'use this when…' trigger describing when it applies, and the step-by-step body. The trigger is the key — it decides when the body auto-loads, so describe the situation, not the steps. Use for a multi-step workflow, debugging routine, setup/release sequence, or the gotchas-and-order of a class of change. For one-off facts ABOUT this codebase use project_memory_store; for facts about the developer use user_memory_store.",
    inputSchema: PlaybookStoreSchema,
    providerOptions: CACHE_CONTROL,
    execute: executePlaybookStore,
  }),

  project_playbook_list: tool({
    description:
      "List stored playbooks with their names, triggers, and ids. Use to see the full library (the always-injected index shows in-scope playbooks; this surfaces all of them) or to find a playbook's id for update/delete.",
    inputSchema: PlaybookListSchema,
    providerOptions: CACHE_CONTROL,
    execute: executePlaybookList,
  }),

  project_playbook_load: tool({
    description:
      "Load a playbook's full body by name (as shown in the index) or id. Use to deliberately pull the steps for a playbook the index named but that wasn't auto-loaded for this task.",
    inputSchema: PlaybookSelectorSchema,
    providerOptions: CACHE_CONTROL,
    execute: executePlaybookLoad,
  }),

  project_playbook_update: tool({
    description:
      "Edit an existing playbook by name or id — rename it (newName), refine its trigger, or revise its body (content). Changing the name or trigger re-embeds it so ambient matching tracks the edit. Prefer updating over storing a near-duplicate.",
    inputSchema: PlaybookUpdateSchema,
    providerOptions: CACHE_CONTROL,
    execute: executePlaybookUpdate,
  }),

  project_playbook_delete: tool({
    description:
      "Delete a playbook by name or id. Confirm with the developer before calling — playbooks are deliberately authored procedures and removal should be intentional.",
    inputSchema: PlaybookSelectorSchema,
    providerOptions: CACHE_CONTROL,
    execute: executePlaybookDelete,
  }),
};
