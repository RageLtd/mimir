/**
 * OpenCode plugin entry — Mimir persona and runtime.
 *
 * Compiled via `bun build` into `dist/mimir-oc.ts` (a single
 * self-contained TS file) and installed at the user's
 * `~/.config/opencode/plugins/`. OpenCode loads it on every startup.
 *
 * Each V2 setup owns its stores, session state, hooks and event subscription.
 *
 * Each handler delegates to the shared `@mimir/plugin-core` layer
 * where possible. The work that lives here is the OpenCode-specific
 * wiring: event-shape translation, in-process tool registration,
 * the `MIMIR_ACTIVE`/config-not-found gating logic, and the
 * detached-cartographer-worker pattern for reindex.
 */

import { join, resolve } from "node:path";
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
import { Plugin } from "@opencode/plugin";
import { assembleBootContext } from "./boot-context";
import { readConfig } from "./config";
import { delegateTool, reviewPromptTool } from "./delegate-tools";
import { OPENCODE_ENVIRONMENT } from "./environment";
import { augmentReadOutput, createFileContextCache } from "./file-context";
import { extractLastUserPrompt, injectLeadingContext } from "./message-inject";
import { orgMemoryTools } from "./org-memory-tools";
import { appendScopedRules, createScopedRulesSeen } from "./scoped-rules";
import { createEventHandler } from "./session-events";
import { normalizeToolCalls } from "./tool-map";
import {
  cartographerTools,
  hygieneTool,
  installTool,
  userMemoryTools,
} from "./tools";
import { persistSessionTranscript } from "./transcript-persistence";
import { appendToolText, toolInput, toolText } from "./v2-tool-results";
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
   * Anchor chosen by prompt admission (per developer turn) for the next
   * context round to inject and clear. Advancing per-turn but injecting
   * per-round keeps cadence at one tick per developer turn.
   */
  pendingAnchor: Anchor | null;
  /**
   * Advice from `severity = "nudge"` rules, queued before tool execution
   * (which can only allow or throw) for the next context round to
   * inject into the recency slot.
   */
  pendingNudges: string[];
};

const getSession = (
  sessions: Map<string, SessionState>,
  sessionId: string,
  libSize: number,
) => {
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

export const MimirPlugin = Plugin.define({
  id: "mimir",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const sessions = new Map<string, SessionState>();
    const fileContextCaches = new Map<
      string,
      ReturnType<typeof createFileContextCache>
    >();
    // 1. Read config. The install tool must exist before config does:
    //    first-run installation is initiated by asking OpenCode to call
    //    `mimir_install`; that tool creates the runtime config and the
    //    reusable slash commands. Returning an empty plugin here made the
    //    documented install path impossible on a clean machine.
    const config = await readConfig();
    if (!config) {
      const install = installTool();
      await ctx.tool.transform((editor) =>
        editor.add({ name: "mimir_install", ...install }),
      );
      return;
    }
    const projectRoot = ctx.location.project.directory;

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
    const projectRuleEntries = await readProjectRules(projectRoot, {
      includeRootFiles: false,
      log,
    }).catch((err) => {
      log.error("project rules read failed", { error: errMessage(err) });
      return [];
    });
    const projectRulesBlock = formatRulesForPrompt(projectRuleEntries);
    const scopedRulesSeen = createScopedRulesSeen();

    // Session → worker role; active tool agents are supplied by V2 hook events.
    const sessionRoles = createSessionRoles(sessionLookupFrom(ctx));

    const anchorIntervalEnv = process.env.MIMIR_ANCHOR_INTERVAL;
    const anchorInterval = anchorIntervalEnv
      ? Number.parseInt(anchorIntervalEnv, 10)
      : 5;
    const ANCHOR_INTERVAL =
      Number.isFinite(anchorInterval) && anchorInterval > 0
        ? anchorInterval
        : 5;

    // V2 tool transforms replay synchronously; store setup stays outside them.
    const tools = {
      ...userMemoryTools(userMemoryStore),
      ...orgMemoryTools(orgReplica),
      ...cartographerTools(projectRoot),
      mimir_install: installTool(),
      mimir_hygiene: hygieneTool(),
      mimir_delegate: delegateTool(directory),
      mimir_review_prompt: reviewPromptTool(directory),
    };
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(tools))
        editor.add({ name, ...definition });
    });

    // V2 splits primary, generate, title and compaction model requests.
    const appendSystem = (output: {
      system: { type: "text"; text: string }[];
    }) => {
      if (systemPromptMarkdown.length > 0) {
        output.system.push({ type: "text", text: systemPromptMarkdown });
      }
      output.system.push({ type: "text", text: OPENCODE_ENVIRONMENT });
      if (projectRulesBlock)
        output.system.push({ type: "text", text: projectRulesBlock });
    };
    await ctx.session.hook("generate", appendSystem);
    await ctx.session.hook("title", appendSystem);

    // Admission can be retried, so a message ID advances cadence only once.
    const admitted = new Set<string>();
    await ctx.session.hook("prompt", async (input) => {
      if (admitted.has(input.messageID)) return;
      admitted.add(input.messageID);
      const s = getSession(
        sessions,
        input.sessionID,
        voiceAnchorLibrary.length,
      );
      const step = nextAnchor(
        s.voiceAnchor,
        voiceAnchorLibrary,
        ANCHOR_INTERVAL,
      );
      s.voiceAnchor = step.next;
      if (step.inject) s.pendingAnchor = step.anchor;
    });

    await ctx.session.hook("context", async (output) => {
      appendSystem(output);
      const sessionId = output.sessionID;
      const s = getSession(sessions, sessionId, voiceAnchorLibrary.length);

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
          projectPath: projectRoot,
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
    });

    // Blocking findings throw; nudge findings wait for the next context hook.
    await ctx.tool.hook("execute.before", async (input) => {
      const projectPath = projectRoot;
      const calls = normalizeToolCalls(input.tool, input.input, directory);

      // Role guard: a `mimir-*` worker's role from its session, the
      // coordinator's from the shared state file, secret reads for
      // everyone. Throwing is the plugin's only deny.
      for (const call of calls) {
        const guard = await guardReason(
          sessionRoles,
          { ...input, tool: call.toolName },
          {
            ...call.toolInput,
            filePath: call.toolInput.file_path ?? call.toolInput.path,
          },
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

      for (const call of calls) {
        const verdict = await runAndPartition(loaded.rules, {
          ...call,
          projectPath,
        }).catch((err) => {
          log.error("runAndPartition failed", { error: errMessage(err) });
          return null;
        });
        if (!verdict) continue;
        if (verdict.nudge) {
          log.info("rule nudge queued", { tool: input.tool });
          getSession(
            sessions,
            input.sessionID,
            voiceAnchorLibrary.length,
          ).pendingNudges.push(verdict.nudge);
        }
        if (verdict.block) {
          log.info("rule violation blocked", { tool: input.tool });
          throw new Error(verdict.block);
        }
      }
    });

    // Only completed tool results have mutable, model-visible content in V2.
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return;
      const args = toolInput(event.input);
      const rawPath = args.filePath ?? args.path;
      const input = {
        tool: event.tool,
        sessionID: event.sessionID,
        callID: event.id,
        args: {
          ...args,
          filePath:
            typeof rawPath === "string" ? resolve(directory, rawPath) : rawPath,
        },
      };
      const original = toolText(event.result);
      const output = {
        title: event.tool,
        output: original,
        metadata: event.result.metadata ?? {},
      };
      const fileContextCache =
        fileContextCaches.get(event.sessionID) ?? createFileContextCache();
      fileContextCaches.set(event.sessionID, fileContextCache);
      // Verify gate on a finished worker: OpenCode can't block a child's
      // stop, so the verdict is appended to the `task` output the
      // coordinator reads. A crash lets the output through untouched.
      const gated = await gateTaskOutput(input, output, projectRoot).catch(
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
        projectRoot,
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
          projectRoot,
          projectRuleEntries,
          scopedRulesSeen,
        )
      ) {
        log.info("scoped project rules appended", { tool: input.tool });
      }
      if (output.output !== original) {
        event.result = appendToolText(
          event.result,
          output.output.slice(original.length),
        );
      }
    });

    // Distill before the compaction request discards the remaining transcript.
    await ctx.session.hook("compaction", async (input) => {
      appendSystem(input);
      if (await sessionRoles.isChild(input.sessionID)) return;
      await persistSessionTranscript(
        input.sessionID,
        projectRoot,
        config,
        log,
        ctx,
      ).catch((err) =>
        log.error("precompact persist crashed", { error: errMessage(err) }),
      );
    });

    // ─── Session lifecycle: reindex, boot sync, distillation ───
    //
    // See session-events.ts. Child (worker) sessions are skipped for
    // distillation — workers persist nothing.
    const handleEvent = createEventHandler({
      config,
      log,
      directory,
      projectPath: projectRoot,
      client: ctx,
      sessionRoles,
    });
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        await handleEvent(event);
      }
    })().catch((err) => {
      if (!controller.signal.aborted)
        log.error("event subscription failed", { error: errMessage(err) });
    });
    return () => {
      controller.abort();
      userMemoryStore?.close();
      orgReplica?.close();
      sessions.clear();
      fileContextCaches.clear();
      scopedRulesSeen.clear();
    };
  },
});

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
