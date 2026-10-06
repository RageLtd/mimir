/**
 * OpenCode `event` handler — the plugin's reactions to file edits and
 * session lifecycle. Extracted from index.ts to keep the entry under
 * the length budget; every branch here is fire-and-forget by design so
 * the model never waits on a reindex, a sync, or a distillation.
 */

import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { errMessage } from "@mimir/plugin-core/util";
import type { MimirConfig } from "./config";
import { runFullReindex, runReindexWorker } from "./reindex";
import {
  _extractionWatermarks,
  persistSessionTranscript,
  type TranscriptClient,
  type TranscriptLogger,
} from "./transcript-persistence";
import type { SessionRoles } from "./worker-hooks";

type SessionEvent = {
  readonly type: string;
  readonly data: unknown;
  readonly location?: { readonly directory: string };
};

const operations = {
  runReindexWorker,
  runFullReindex,
  reconcileFromSharedConfig,
  syncFromSharedConfig,
  persistSessionTranscript,
};

export const createEventHandler = (
  deps: {
    readonly config: MimirConfig;
    readonly log: TranscriptLogger;
    readonly directory: string;
    readonly projectPath?: string;
    readonly client: TranscriptClient;
    readonly sessionRoles: SessionRoles;
  },
  ops: typeof operations = operations,
) => {
  const { config, log, directory, client, sessionRoles } = deps;
  const projectPath = deps.projectPath ?? directory;

  const handler = async (event: SessionEvent) => {
    if (event.location?.directory !== directory) return;
    const data = event.data;
    if (typeof data !== "object" || data === null) return;
    // ─── Cartographer reindex on file edit ───
    //
    // OpenCode emits `filesystem.changed` when a file changes in the
    // filesystem. Spawn a one-shot cartographer reindex for that file,
    // detached so the model isn't waiting on a Rust subprocess.
    if (
      event.type === "filesystem.changed" &&
      "file" in data &&
      typeof data.file === "string"
    ) {
      const filePath = data.file;
      void ops
        .runReindexWorker(log, config, projectPath, filePath)
        .catch((err) =>
          log.error("reindex worker crashed", { error: errMessage(err) }),
        );
      return;
    }

    if (!("sessionID" in data) || typeof data.sessionID !== "string") return;
    const sessionID = data.sessionID;
    if (
      event.type === "session.agent.selected" ||
      event.type === "session.deleted"
    ) {
      sessionRoles.invalidate(sessionID);
      if (event.type === "session.deleted")
        _extractionWatermarks.delete(sessionID);
      return;
    }

    if (event.type === "session.created") {
      sessionRoles.invalidate(sessionID);
      if (await sessionRoles.isChild(sessionID)) return;
      // Full project reindex: walk every git-tracked source file, parse
      // each, sync as a single replace-mode payload. runFullReindex
      // self-guards when no cartographer binary is configured.
      void ops
        .runFullReindex(log, config, projectPath)
        .catch((err) =>
          log.error("full reindex crashed", { error: errMessage(err) }),
        );
      // Silent key reconcile (MIM-87) then blind sync (MIM-88): fulfil
      // pending wraps, pull/push org memories. Never blocks the session,
      // never mints secrets; sync skips the embedder at boot.
      void ops
        .reconcileFromSharedConfig()
        .then((result) => log.info("key reconcile", { ...result }))
        .then(() => ops.syncFromSharedConfig())
        .then((result) => log.info("org sync", { ...result }))
        .catch((err) =>
          log.error("boot reconcile crashed", { error: errMessage(err) }),
        );
      return;
    }

    if (event.type === "session.idle") {
      // Workers persist nothing: a child session's turns are the
      // coordinator's to summarise, not memory in their own right.
      if (await sessionRoles.isChild(sessionID)) return;
      // Distill the session's new turns into the local replica (MIM-86),
      // then push them through the blind sync relay (MIM-88). The
      // per-session watermark makes repeat idles cheap; storeTyped
      // dedupes; sync skips the embedder.
      void ops
        .persistSessionTranscript(sessionID, projectPath, config, log, client)
        .then(() => ops.syncFromSharedConfig())
        .then((result) => log.info("post-distill sync", { ...result }))
        .catch((err) =>
          log.error("transcript persist crashed", { error: errMessage(err) }),
        );
    }
  };
  return handler;
};
