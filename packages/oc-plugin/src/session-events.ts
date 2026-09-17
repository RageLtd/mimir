/**
 * OpenCode `event` handler — the plugin's reactions to file edits and
 * session lifecycle. Extracted from index.ts to keep the entry under
 * the length budget; every branch here is fire-and-forget by design so
 * the model never waits on a reindex, a sync, or a distillation.
 */

import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { errMessage } from "@mimir/plugin-core/util";
import type { Hooks } from "@opencode-ai/plugin";
import type { MimirConfig } from "./config";
import { runFullReindex, runReindexWorker } from "./reindex";
import {
  persistSessionTranscript,
  type TranscriptClient,
  type TranscriptLogger,
} from "./transcript-persistence";
import type { SessionRoles } from "./worker-hooks";

type EventHandler = NonNullable<Hooks["event"]>;

export const createEventHandler = (deps: {
  readonly config: MimirConfig;
  readonly log: TranscriptLogger;
  readonly directory: string;
  readonly client: TranscriptClient;
  readonly sessionRoles: SessionRoles;
}) => {
  const { config, log, directory, client, sessionRoles } = deps;

  const handler: EventHandler = async ({ event }) => {
    // ─── Cartographer reindex on file edit ───
    //
    // OpenCode emits `file.edited` whenever a tool writes to the
    // filesystem. Spawn a one-shot cartographer reindex for that file,
    // detached so the model isn't waiting on a Rust subprocess.
    if (event.type === "file.edited") {
      const filePath = event.properties.file;
      void runReindexWorker(log, config, directory, filePath).catch((err) =>
        log.error("reindex worker crashed", { error: errMessage(err) }),
      );
      return;
    }

    if (event.type === "session.created") {
      // Full project reindex: walk every git-tracked source file, parse
      // each, sync as a single replace-mode payload. runFullReindex
      // self-guards when no cartographer binary is configured.
      void runFullReindex(log, config, directory).catch((err) =>
        log.error("full reindex crashed", { error: errMessage(err) }),
      );
      // Silent key reconcile (MIM-87) then blind sync (MIM-88): fulfil
      // pending wraps, pull/push org memories. Never blocks the session,
      // never mints secrets; sync skips the embedder at boot.
      void reconcileFromSharedConfig()
        .then((result) => log.info("key reconcile", { ...result }))
        .then(() => syncFromSharedConfig())
        .then((result) => log.info("org sync", { ...result }))
        .catch((err) =>
          log.error("boot reconcile crashed", { error: errMessage(err) }),
        );
      return;
    }

    if (event.type === "session.idle") {
      // Workers persist nothing: a child session's turns are the
      // coordinator's to summarise, not memory in their own right.
      if (await sessionRoles.isChild(event.properties.sessionID)) return;
      // Distill the session's new turns into the local replica (MIM-86),
      // then push them through the blind sync relay (MIM-88). The
      // per-session watermark makes repeat idles cheap; storeTyped
      // dedupes; sync skips the embedder.
      void persistSessionTranscript(
        event.properties.sessionID,
        directory,
        config,
        log,
        client,
      )
        .then(() => syncFromSharedConfig())
        .then((result) => log.info("post-distill sync", { ...result }))
        .catch((err) =>
          log.error("transcript persist crashed", { error: errMessage(err) }),
        );
    }
  };
  return handler;
};
