/**
 * OpenCode plugin entry — Mimir persona and runtime.
 *
 * Compiled via `bun build` into `dist/mimir-oc.ts` (a single
 * self-contained TS file) and installed at the user's
 * `~/.config/opencode/plugins/`. OpenCode loads it on every startup.
 *
 * Shared state is captured in the closure returned from the Plugin
 * function: the user-memory store, the parsed voice-anchor library,
 * per-session caches, and the file logger. OpenCode invokes the
 * returned `Hooks` callbacks as the user interacts.
 *
 * Each handler delegates to the shared `@mimir/plugin-core` layer
 * where possible. The work that lives here is the OpenCode-specific
 * wiring: event-shape translation, in-process tool registration,
 * the `MIMIR_ACTIVE`/config-not-found gating logic, and the
 * detached-cartographer-worker pattern for reindex.
 */

import { join } from "node:path";
import { runKeysCommand } from "@mimir/plugin-core/keys/cli";
import { createLoggerFactory } from "@mimir/plugin-core/logger";
import { markdownToXml } from "@mimir/plugin-core/markdown-to-xml";
import {
  formatRulesForPrompt,
  loadRules,
  readProjectRules,
  runAndPartition,
} from "@mimir/plugin-core/rules";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
  type OrgReplica,
} from "@mimir/plugin-core/store/org-replica";
import {
  createUserMemoryStore,
  type UserMemoryStore,
} from "@mimir/plugin-core/store/user-memories";
import { runSyncCommand } from "@mimir/plugin-core/sync/cli";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import {
  type VoiceAnchor as Anchor,
  createSessionVoiceAnchor,
  formatAnchor,
  nextAnchor,
  parseVoiceAnchors,
  type VoiceAnchorState,
} from "@mimir/plugin-core/voice-anchor";
import type { Plugin } from "@opencode-ai/plugin";
import { assembleBootContext } from "./boot-context";
import { readConfig } from "./config";
import { delegateTool, reviewPromptTool } from "./delegate-tools";
import { augmentReadOutput, createFileContextCache } from "./file-context";
import {
  extractLastUserPrompt,
  injectLeadingContext,
  lastUserMessage,
} from "./message-inject";
import { orgMemoryTools } from "./org-memory-tools";
import { appendScopedRules, createScopedRulesSeen } from "./scoped-rules";
import { createEventHandler } from "./session-events";
import {
  cartographerTools,
  hygieneTool,
  installTool,
  userMemoryTools,
} from "./tools";
import { persistSessionTranscript } from "./transcript-persistence";
import {
  createSessionRoles,
  gateTaskOutput,
  guardReason,
  sessionLookupFrom,
} from "./worker-hooks";

// ── Per-session state ──

type SessionState = {
  voiceAnchor: VoiceAnchorState;
  /** True after the first developer turn for this session. */
  bootDone: boolean;
  /**
   * Anchor chosen by `chat.message` (per developer turn) for the next
   * transform round to inject and clear. Advancing per-turn but injecting
   * per-round keeps cadence at one tick per developer turn.
   */
  pendingAnchor: Anchor | null;
  /**
   * Advice from `severity = "nudge"` rules, queued by tool.execute.before
   * (which can only allow or throw) for the next transform round to
   * inject into the recency slot.
   */
  pendingNudges: string[];
};

const sessions = new Map<string, SessionState>();

// Per-session file-context cache, keyed by file path. One Map for
// the lifetime of the plugin entry (== lifetime of the OpenCode
// process) — entries accumulate across session.idle events, get
// invalidated by the cartographer's content_hash.
const fileContextCache = createFileContextCache();

const getSession = (sessionId: string, libSize: number): SessionState => {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      voiceAnchor: createSessionVoiceAnchor(sessionId, libSize),
      bootDone: false,
      pendingAnchor: null,
      pendingNudges: [],
    };
    sessions.set(sessionId, s);
  }
  return s;
};

// ── Plugin entry ──

export const MimirPlugin: Plugin = async (ctx) => {
  // 1. Read config. The install tool must exist before config does:
  //    first-run installation is initiated by asking OpenCode to call
  //    `mimir_install`; that tool creates the runtime config and the
  //    reusable slash commands. Returning an empty plugin here made the
  //    documented install path impossible on a clean machine.
  const config = await readConfig();
  if (!config) {
    return { tool: { mimir_install: installTool() } };
  }

  // 2. Set up logger. Writes to ~/.mimir/logs/mimir-oc.log with the
  //    previous-log rotation. Mirrors the cc-plugin's pattern.
  const log = createLoggerFactory(
    "mimir-oc.log",
    "mimir-oc.prev.log",
  ).createLogger("mimir-oc");

  // 3. Open the local memory stores: developer facts in user-memories.db,
  //    project memories and playbooks in the org replica.
  let userMemoryStore: UserMemoryStore | null = null;
  try {
    userMemoryStore = createUserMemoryStore(config.userMemoryDb);
  } catch (err) {
    log.warn("user-memory store open failed", { error: errMessage(err) });
  }

  let orgReplica: OrgReplica | null = null;
  try {
    orgReplica = createOrgReplica(
      process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
    );
  } catch (err) {
    log.warn("org replica open failed", { error: errMessage(err) });
  }

  // 4. Load the persona system prompt and parse voice anchors. The
  //    raw markdown is what we append to the system prompt; the XML
  //    form is what the anchor parser needs. Both are cached.
  const promptPath = join(mimirHome(), "system-prompt.md");
  const promptFile = Bun.file(promptPath);
  let systemPromptMarkdown = "";
  let voiceAnchorLibrary: Anchor[] = [];
  if (await promptFile.exists()) {
    systemPromptMarkdown = await promptFile.text();
    try {
      const promptXml = markdownToXml(systemPromptMarkdown);
      voiceAnchorLibrary = parseVoiceAnchors(promptXml);
    } catch (err) {
      log.warn("voice anchor parse failed", { error: errMessage(err) });
    }
  }

  // 5. Project prose rules (.claude/rules/**/*.md). OpenCode loads the
  //    root AGENTS.md itself, so only the rules directory is read here.
  //    Always-on rules ride in the system prompt; path-scoped rules are
  //    appended to `read` output the first time a matching file is read.
  const projectRuleEntries = await readProjectRules(ctx.directory, {
    includeRootFiles: false,
    log,
  }).catch((err) => {
    log.error("project rules read failed", { error: errMessage(err) });
    return [];
  });
  const projectRulesBlock = formatRulesForPrompt(projectRuleEntries);
  const scopedRulesSeen = createScopedRulesSeen();

  // Session → worker role, one SDK lookup per session (cached).
  const sessionRoles = createSessionRoles(sessionLookupFrom(ctx.client));

  const anchorIntervalEnv = process.env.MIMIR_ANCHOR_INTERVAL;
  const anchorInterval = anchorIntervalEnv
    ? Number.parseInt(anchorIntervalEnv, 10)
    : 5;
  const ANCHOR_INTERVAL =
    Number.isFinite(anchorInterval) && anchorInterval > 0 ? anchorInterval : 5;

  return {
    // ─── Memory + install tools ───
    //
    // In-process custom tools (no MCP round-trip). User memory, project
    // memory, and playbooks match what the cc-plugin exposes via stdio MCP.
    // The install tool is the runtime half of the slash command at
    // `commands/mimir-install.md` — the model calls it with the user's
    // chosen parameters and the tool writes the config files.
    //
    // Memory tools graceful-degrade when a store is unavailable; the install
    // tool checks for the plugin bundle + MIMIR_API_KEY first.
    tool: {
      ...userMemoryTools(userMemoryStore),
      ...orgMemoryTools(orgReplica),
      ...cartographerTools(ctx.directory),
      mimir_install: installTool(),
      mimir_hygiene: hygieneTool(),
      mimir_delegate: delegateTool(),
      mimir_review_prompt: reviewPromptTool(),
    },

    // ─── Persona system prompt + project rules ───
    //
    // Append the Mimir persona, then the always-on project rules, to
    // the system prompt on every model call. Runs before chat.params,
    // after OpenCode's own system prompt construction. Both are static
    // after init, so no per-call work — the values are cached.
    "experimental.chat.system.transform": async (_input, output) => {
      // `output.system` is a string[] — each block is one more entry,
      // not a re-stringification of the whole array.
      if (systemPromptMarkdown.length > 0) {
        output.system.push(systemPromptMarkdown);
      }
      if (projectRulesBlock) output.system.push(projectRulesBlock);
    },

    // ─── Turn counting + anchor cadence ───
    //
    // chat.message fires once per developer turn. Advance the anchor
    // rotation here (per-turn cadence) and stash the anchor to inject;
    // the transform hook — which fires once per LLM round, several times
    // per turn — only injects the pending anchor, so the cadence stays
    // one tick per developer turn rather than one per round.
    "chat.message": async (input) => {
      const s = getSession(input.sessionID, voiceAnchorLibrary.length);
      const step = nextAnchor(
        s.voiceAnchor,
        voiceAnchorLibrary,
        ANCHOR_INTERVAL,
      );
      s.voiceAnchor = step.next;
      if (step.inject) s.pendingAnchor = step.anchor;
    },

    // ─── Voice anchor + retrieval injection ───
    //
    // Runs before every LLM call. On the right cadence, prepends a
    // <voice_anchor> block to the most recent user message so the
    // recency slot carries the persona's voice.
    //
    // First-turn detection: when the session hasn't seen a developer
    // prompt yet, emit the boot-context block (user profile + prior
    // session context) so the model reads it as the leading content
    // of its first user turn. The cc-plugin's voice-anchor handles
    // this; we do the same.
    "experimental.chat.messages.transform": async (_input, output) => {
      // This hook's input is `{}` — no sessionID. Derive it from the
      // messages themselves (every Message carries sessionID).
      const sessionId = lastUserMessage(output.messages)?.info.sessionID;
      if (!sessionId) return;
      const s = getSession(sessionId, voiceAnchorLibrary.length);

      // Injected blocks lead the recency slot in order: boot first (only
      // once, on the session's first turn), then any pending voice anchor.
      const blocks: string[] = [];

      if (!s.bootDone) {
        s.bootDone = true;
        // assembleBootContext reads the user-memory store and the local
        // org replica (MIM-86), returning a <boot_context> XML block
        // ready for injection.
        const boot = await assembleBootContext({
          promptText: extractLastUserPrompt(output.messages),
          projectPath: ctx.directory,
          config,
          userMemoryStore,
        }).catch((err) => {
          log.error("assembleBootContext threw", { error: errMessage(err) });
          return null;
        });
        if (boot) blocks.push(boot);
      }

      if (s.pendingAnchor) {
        blocks.push(formatAnchor(s.pendingAnchor));
        s.pendingAnchor = null;
      }

      if (s.pendingNudges.length > 0) {
        blocks.push(...s.pendingNudges);
        s.pendingNudges = [];
      }

      injectLeadingContext(output.messages, blocks);
    },

    // ─── Rules engine ───
    //
    // Runs on every tool call. Loads `.claude/**/*.enforce.toml` from
    // the project root and evaluates conditions/built-ins. A blocking
    // finding throws — that fails the tool call with the findings as
    // the error, the only deny this hook has. A nudge finding lets the
    // call run and queues the advice for the next transform round.
    "tool.execute.before": async (input, output) => {
      const projectPath = ctx.directory;

      // Role guard: a `mimir-*` worker's role from its session, the
      // coordinator's from the shared state file, secret reads for
      // everyone. Throwing is the plugin's only deny.
      const guard = await guardReason(
        sessionRoles,
        input,
        output.args as Record<string, unknown>,
        projectPath,
      ).catch((err) => {
        log.error("role guard crashed — allowing the call", {
          error: errMessage(err),
        });
        return null;
      });
      if (guard) {
        log.info("role guard denied", { tool: input.tool });
        throw new Error(guard);
      }
      const loaded = await loadRules(projectPath).catch((err) => {
        log.error("loadRules failed", { error: errMessage(err) });
        return null;
      });
      if (!loaded || loaded.rules.length === 0) return;

      if (loaded.errors.length > 0) {
        log.warn("some rules failed to load", {
          count: loaded.errors.length,
        });
      }

      const verdict = await runAndPartition(loaded.rules, {
        toolName: input.tool,
        toolInput: output.args as Record<string, unknown>,
        projectPath,
      }).catch((err) => {
        log.error("runAndPartition failed", { error: errMessage(err) });
        return null;
      });
      if (!verdict) return;
      if (verdict.nudge) {
        log.info("rule nudge queued", { tool: input.tool });
        getSession(
          input.sessionID,
          voiceAnchorLibrary.length,
        ).pendingNudges.push(verdict.nudge);
      }
      if (verdict.block) {
        log.info("rule violation blocked", { tool: input.tool });
        throw new Error(verdict.block);
      }
    },

    // ─── File-context on Read ───
    //
    // After every `read` tool call, fetch cartographer file-info and
    // append a `<file_context>` block to the output. The cartographer
    // already has symbols, imports, dependents, and related memories
    // for any indexed file — the model gets a richer picture of what
    // it's reading without the read tool itself having to know.
    //
    // The cache is per-session and content-hash-keyed: re-reading the
    // same file (with no edits between) is a no-op. Cached against
    // the cartographer's reported hash, not a local recompute.
    "tool.execute.after": async (input, output) => {
      // Verify gate on a finished worker: OpenCode can't block a child's
      // stop, so the verdict is appended to the `task` output the
      // coordinator reads. A crash lets the output through untouched.
      const gated = await gateTaskOutput(input, output, ctx.directory).catch(
        (err) => {
          log.error("verify gate crashed — output left as is", {
            error: errMessage(err),
          });
          return null;
        },
      );
      if (gated) log.info("verify gate", { kind: gated });

      await augmentReadOutput(
        input,
        output,
        ctx.directory,
        config,
        log,
        fileContextCache,
      ).catch((err) => {
        log.error("file-context augment crashed", {
          tool: input.tool,
          error: errMessage(err),
        });
      });
      // Path-scoped prose rules for the file just read, once per session.
      if (
        appendScopedRules(
          input,
          output,
          ctx.directory,
          projectRuleEntries,
          scopedRulesSeen,
        )
      ) {
        log.info("scoped project rules appended", { tool: input.tool });
      }
    },

    // ─── Distill before compaction ───
    //
    // Fires before OpenCode summarizes the session away. Extract the
    // remaining delta into the local replica first so the facts survive
    // the discard — the parity of cc-plugin's PreCompact hook. Awaited
    // (not fire-and-forget) so extraction completes before the discard;
    // the watermark makes overlap with the session.idle pass cheap.
    "experimental.session.compacting": async (input) => {
      await persistSessionTranscript(
        input.sessionID,
        ctx.directory,
        config,
        log,
        ctx.client,
      ).catch((err) =>
        log.error("precompact persist crashed", { error: errMessage(err) }),
      );
    },

    // ─── Session lifecycle: reindex, boot sync, distillation ───
    //
    // See session-events.ts. Child (worker) sessions are skipped for
    // distillation — workers persist nothing.
    event: createEventHandler({
      config,
      log,
      directory: ctx.directory,
      client: ctx.client,
      sessionRoles,
    }),
  };
};

export default MimirPlugin;

// Argv-program mode: the `mimir` wrapper dispatches `keys …` / `sync` to
// this bundle directly (`bun mimir-oc.ts keys …`). import.meta.main is
// false when OpenCode imports the file as a plugin, so this path is
// inert in normal operation — one artifact, two roles (MIM-87/88
// editor-agnostic ceremony rule).
if (import.meta.main && Bun.argv[2] === "keys") {
  process.exit(await runKeysCommand(Bun.argv.slice(3)));
}
if (import.meta.main && Bun.argv[2] === "sync") {
  process.exit(await runSyncCommand());
}
