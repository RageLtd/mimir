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
 * The binary's --parse-only output is forwarded as-is; no intermediate
 * type conversion needed.
 */
export const syncIndex = async (
  config: CartographerSyncConfig,
  rawJson: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> => {
  const url = `${config.serverUrl}/v1/cartographer/sync`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: rawJson,
    });

    if (!response.ok) {
      const body = await response.text();
      config.logger.error(
        `Cartographer sync failed: ${response.status} ${body}`,
      );
      return { ok: false, error: `${response.status}: ${body}` };
    }

    config.logger.info("Cartographer sync OK");
    return { ok: true };
  } catch (err) {
    const message = errMessage(err);
    config.logger.error(`Cartographer sync error: ${message}`);
    return { ok: false, error: message };
  }
};
