/**
 * Provider metadata lifecycle — models.dev data held in memory with a TTL
 * refresh (MIM-65).
 *
 * The old flow fetched models.dev at boot and wrote provider-data.json to
 * disk: boot crashed outright when models.dev was down, and the artifact
 * was useless on ephemeral container filesystems. Now the data lives in
 * memory only — a failed fetch degrades to local-providers-only, and a
 * faster retry loop self-heals once models.dev answers.
 *
 * The refresh callback is injected (index.ts passes the registry init)
 * rather than imported, to avoid a runtime cycle with registry.ts — which
 * imports `getProviderData` from here. Registry registration is additive
 * (entries are overwritten, maps never cleared), so re-running it after a
 * refresh is safe with requests in flight.
 */

import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import type { ProviderEntry } from "./registry";

const FETCH_TIMEOUT_MS = 10_000;
/** Normal refresh cadence once data is loaded. */
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
/** Fast retry while the store is empty — a boot during a models.dev outage
 *  recovers in minutes instead of waiting out the full TTL. */
const EMPTY_RETRY_MS = 15 * 60 * 1000;

let store: Record<string, ProviderEntry> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/** Current in-memory provider metadata. Empty until the first successful load. */
export const getProviderData = () => store;

/** Pure: next refresh delay given whether the store holds data. Exported for tests. */
export const nextRefreshDelay = (hasData: boolean) =>
  hasData ? REFRESH_TTL_MS : EMPTY_RETRY_MS;

const hasData = () => Object.keys(store).length > 0;

/**
 * Fetch models.dev into memory. Never throws; returns whether the store
 * holds data afterwards. A failed fetch keeps whatever the store already
 * had — stale beats empty.
 */
export async function loadProviderData() {
  const url = config.providerData.url;
  const [err, res] = await attempt(() =>
    fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  );
  if (err) {
    log.warn({ err: err.message, url }, "provider data fetch failed");
    return hasData();
  }
  if (!res.ok) {
    log.warn({ url, status: res.status }, "provider data fetch returned error");
    return hasData();
  }
  const [parseErr, json] = await attempt(
    () => res.json() as Promise<Record<string, ProviderEntry>>,
  );
  if (parseErr) {
    log.warn({ err: parseErr.message, url }, "provider data parse failed");
    return hasData();
  }
  store = json;
  log.info({ providers: Object.keys(store).length }, "provider data loaded");
  return true;
}

/**
 * Start the TTL refresh loop. Each tick reloads models.dev and, on a load
 * that leaves the store populated, runs `onRefresh` to re-register
 * providers. Timers are unref'd — the loop never holds the process open.
 */
export function startProviderDataRefresh(onRefresh: () => Promise<unknown>) {
  const schedule = () => {
    timer = setTimeout(async () => {
      const loaded = await loadProviderData();
      if (loaded) {
        const [err] = await attempt(onRefresh);
        if (err) {
          log.warn({ err: err.message }, "provider registry refresh failed");
        }
      }
      schedule();
    }, nextRefreshDelay(hasData()));
    timer.unref();
  };
  schedule();
}

export function stopProviderDataRefresh() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
