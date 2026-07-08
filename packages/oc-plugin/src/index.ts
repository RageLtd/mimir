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
import { createLoggerFactory } from "@mimir/plugin-core/logger";
import { markdownToXml } from "@mimir/plugin-core/markdown-to-xml";
import { loadRules, runAndFormat } from "@mimir/plugin-core/rules";
import {
  createUserMemoryStore,
  type UserMemoryStore,
} from "@mimir/plugin-core/store/user-memories";
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
import { augmentReadOutput, createFileContextCache } from "./file-context";
import {
  extractLastUserPrompt,
  injectLeadingContext,
  lastUserMessage,
} from "./message-inject";
import { runFullReindex, runReindexWorker } from "./reindex";
import {
  cartographerTools,
  hygieneTool,
  installTool,
  userMemoryTools,
} from "./tools";
import { persistSessionTranscript } from "./transcript-persistence";

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
    };
    sessions.set(sessionId, s);
  }
  return s;
};

// ── Plugin entry ──

export const MimirPlugin: Plugin = async (ctx) => {
  // 1. Read config. If absent, the plugin no-ops — OpenCode runs
  //    normally and the user is expected to run /mimir-install.
  const config = await readConfig();
  if (!config) {
    return {};
  }

  // 2. Set up logger. Writes to ~/.mimir/logs/mimir-oc.log with the
  //    previous-log rotation. Mirrors the cc-plugin's pattern.
  const log = createLoggerFactory(
    "mimir-oc.log",
    "mimir-oc.prev.log",
  ).createLogger("mimir-oc");

  // 3. Open user-memory store. The DB lives at the path the install
  //    flow wrote — usually ~/.mimir/user-memories.db.
  let userMemoryStore: UserMemoryStore | null = null;
  try {
    userMemoryStore = createUserMemoryStore(config.userMemoryDb);
  } catch (err) {
    log.warn("user-memory store open failed", { error: errMessage(err) });
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

  const anchorIntervalEnv = process.env.MIMIR_ANCHOR_INTERVAL;
  const anchorInterval = anchorIntervalEnv
    ? Number.parseInt(anchorIntervalEnv, 10)
    : 5;
  const ANCHOR_INTERVAL =
    Number.isFinite(anchorInterval) && anchorInterval > 0 ? anchorInterval : 5;

  return {
    // ─── User-memory + install tools ───
    //
    // In-process custom tools (no MCP round-trip). The seven user-memory
    // tools match what the cc-plugin exposes via stdio MCP. The install
    // tool is the runtime half of the slash command at
    // `commands/mimir-install.md` — the model calls it with the user's
    // chosen parameters and the tool writes the config files.
    //
    // Both graceful-degrade when the store is null (uninitialised) —
    // user-memory tools report "store not initialised" and the install
    // tool checks for the plugin bundle + MIMIR_API_KEY first.
    tool: {
      ...userMemoryTools(userMemoryStore),
      ...cartographerTools(ctx.directory),
      mimir_install: installTool(),
      mimir_hygiene: hygieneTool(),
    },

    // ─── Persona system prompt ───
    //
    // Append the Mimir persona to the system prompt on every model
    // call. Runs before chat.params, after OpenCode's own system
    // prompt construction. The persona is static after install, so
    // no per-call fetch — the value is cached at plugin init.
    "experimental.chat.system.transform": async (_input, output) => {
      if (systemPromptMarkdown.length === 0) return;
      // `output.system` is a string[] — the persona is one more entry,
      // not a re-stringification of the whole array.
      output.system.push(systemPromptMarkdown);
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

      injectLeadingContext(output.messages, blocks);
    },

    // ─── Rules engine ───
    //
    // Runs on every tool call. Loads `.claude/**/*.enforce.toml` from
    // the project root, evaluates conditions/built-ins, throws on
    // violation. Throwing from tool.execute.before fails the tool
    // call with the nudge as the error message — the model sees the
    // violation alongside the call and can amend.
    "tool.execute.before": async (input, output) => {
      const projectPath = ctx.directory;
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

      const nudge = await runAndFormat(loaded.rules, {
        toolName: input.tool,
        toolInput: output.args as Record<string, unknown>,
        projectPath,
      }).catch((err) => {
        log.error("runAndFormat failed", { error: errMessage(err) });
        return null;
      });
      if (nudge) {
        log.info("rule violation surfaced", { tool: input.tool });
        throw new Error(nudge);
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

    // ─── Cartographer reindex on file edit ───
    //
    // OpenCode emits a `file.edited` event whenever a tool writes to
    // the filesystem. We respond by spawning a one-shot cartographer
    // reindex for that file. Detached from the event handler so the
    // model isn't waiting on a Rust subprocess + HTTP round-trip.
    event: async ({ event }) => {
      if (event.type === "file.edited") {
        const filePath = event.properties.file;
        const projectPath = ctx.directory;
        // Fire-and-forget; reindex failures are logged but never
        // surface as tool errors.
        void runReindexWorker(log, config, projectPath, filePath).catch((err) =>
          log.error("reindex worker crashed", { error: errMessage(err) }),
        );
        return;
      }

      if (event.type === "session.created") {
        // Full project reindex: walk every git-tracked source file,
        // parse each, sync as a single replace-mode payload. Detached so
        // session startup isn't blocked; runFullReindex self-guards when
        // no cartographer binary is configured.
        void runFullReindex(log, config, ctx.directory).catch((err) =>
          log.error("full reindex crashed", { error: errMessage(err) }),
        );
        return;
      }

      if (event.type === "session.idle") {
        // Distill the session's new turns into the local replica
        // (MIM-86). Fire-and-forget: errors are logged inside the
        // function but never propagated. The per-session watermark
        // makes repeat idles cheap; storeTyped dedupes.
        void persistSessionTranscript(
          event.properties.sessionID,
          ctx.directory,
          config,
          log,
          ctx.client,
        ).catch((err) =>
          log.error("transcript persist crashed", { error: errMessage(err) }),
        );
        return;
      }
    },
  };
};

export default MimirPlugin;
