/**
 * Cartographer index sync to mimir-server.
 *
 * Forwards the raw JSON output from the cartographer binary's --parse-only
 * mode to mimir-server's sync endpoint. The server persists to SurrealDB
 * so query tools (search, graph walk, file info) work cross-project.
 */

import { errMessage } from "../util";
import type { Logger } from "../utils/log";

export type CartographerSyncConfig = {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly logger: Logger;
};

/**
 * Post raw JSON from the cartographer binary to the server sync endpoint.
 * When `projectId` is provided, it's injected into the payload so the
 * server keys cart records by the canonical project UUID. Otherwise the
 * server falls back to using `rootPath` (legacy behaviour).
 */
export const syncIndex = async (
  config: CartographerSyncConfig,
  rawJson: string,
  projectId?: string | null,
) => {
  const url = `${config.serverUrl}/v1/cartographer/sync`;

  // Inject projectId into the payload when present — cheaper than a second
  // round-trip and lets the server key cart records by UUID.
  const body = projectId
    ? JSON.stringify({ ...JSON.parse(rawJson), projectId })
    : rawJson;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body,
  }).catch((err) => {
    const message = errMessage(err);
    config.logger.error(`Cartographer sync error: ${message}`);
    return null;
  });
  if (!response) return { ok: false, error: "network error" };

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    config.logger.error(
      `Cartographer sync failed: ${response.status} ${errText}`,
    );
    return { ok: false, error: `${response.status}: ${errText}` };
  }

  config.logger.info("Cartographer sync OK");
  return { ok: true };
};
