/**
 * Cartographer index sync to mimir-server.
 *
 * Pushes parsed file data from the local cartographer binary to
 * mimir-server's sync endpoint over HTTPS. The server persists to
 * SurrealDB so query tools (search, graph walk, file info) work
 * cross-project.
 *
 * Currently the Rust binary writes to SurrealDB directly (shared
 * instance with mimir-server), making this sync redundant. This
 * module exists for the future --parse-only mode where the binary
 * produces JSON output without DB access and mimir-acp handles
 * persistence via HTTP.
 */

import type { Logger } from "../utils/log";

export type CartographerSyncConfig = {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly logger: Logger;
};

export type SyncFileEntry = {
  readonly path: string;
  readonly language: string;
  readonly symbols: readonly {
    readonly name: string;
    readonly kind: string;
    readonly signature?: string;
    readonly visibility?: string;
    readonly line: number;
  }[];
  readonly imports: readonly {
    readonly target: string;
    readonly specifier: string;
    readonly symbols: readonly string[];
  }[];
};

export type IndexPayload = {
  readonly projectPath: string;
  readonly files: readonly SyncFileEntry[];
};

export const syncIndex = async (
  config: CartographerSyncConfig,
  payload: IndexPayload,
): Promise<{ readonly ok: boolean; readonly error?: string }> => {
  const url = `${config.serverUrl}/v1/cartographer/sync`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      config.logger.error(
        `Cartographer sync failed: ${response.status} ${body}`,
      );
      return { ok: false, error: `${response.status}: ${body}` };
    }

    config.logger.info(
      `Cartographer sync OK: ${payload.projectPath} (${payload.files.length} files)`,
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    config.logger.error(`Cartographer sync error: ${message}`);
    return { ok: false, error: message };
  }
};
