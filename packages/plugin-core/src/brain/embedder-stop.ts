/**
 * Stopping the local embedder — install/update only. Hooks never call
 * this: per reuse-processes they get-or-start and leave the server to
 * sleep. A server from before an install keeps the previous binary and
 * flags for as long as it lives, so the installer stops it once the new
 * artifacts are in place and the next caller spawns the current one.
 *
 * Only the pinned binary is ever signalled. The listener is found through
 * the port (lsof) and checked against its command line (ps) first — a
 * stranger on the port is reported, not killed.
 */

import { $ } from "bun";
import { attemptSync } from "../result";
import {
  embedderBaseUrl,
  embedderBinaryPath,
  embedderPort,
  HEALTH_TIMEOUT_MS,
  probeHealthy,
} from "./embedder";

/** How long to wait for a SIGTERM'd server to leave the port. */
const STOP_WAIT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 200;

export type StopOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "stopped"; readonly pid: number }
  | { readonly kind: "kept"; readonly reason: string };

/** PID of the process listening on the port, or null when unknown. */
const listenerPid = async (port: number) => {
  const found = await $`lsof -t -iTCP:${port} -sTCP:LISTEN`.quiet().nothrow();
  const pid = Number.parseInt(found.text().trim().split("\n")[0] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

/** Command line of a live process; empty when it is gone. */
const commandOf = async (pid: number) =>
  (await $`ps -o command= -p ${pid}`.quiet().nothrow()).text().trim();

export const stopEmbedder = async (healthTimeoutMs = HEALTH_TIMEOUT_MS) => {
  const port = embedderPort();
  const baseUrl = embedderBaseUrl();
  if (!(await probeHealthy(baseUrl, healthTimeoutMs)))
    return { kind: "absent" } satisfies StopOutcome;
  const pid = await listenerPid(port);
  if (pid === null)
    return {
      kind: "kept",
      reason: `could not identify the process on port ${port} (is lsof installed?)`,
    } satisfies StopOutcome;
  if (!(await commandOf(pid)).includes(embedderBinaryPath()))
    return {
      kind: "kept",
      reason: `pid ${pid} on port ${port} is not the pinned llama-server`,
    } satisfies StopOutcome;
  const [killErr] = attemptSync(() => process.kill(pid, "SIGTERM"));
  if (killErr)
    return {
      kind: "kept",
      reason: `SIGTERM to pid ${pid} failed: ${killErr.message}`,
    } satisfies StopOutcome;
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await probeHealthy(baseUrl, healthTimeoutMs)))
      return { kind: "stopped", pid } satisfies StopOutcome;
    await Bun.sleep(STOP_POLL_INTERVAL_MS);
  }
  return {
    kind: "kept",
    reason: `pid ${pid} still answering ${STOP_WAIT_MS}ms after SIGTERM`,
  } satisfies StopOutcome;
};
