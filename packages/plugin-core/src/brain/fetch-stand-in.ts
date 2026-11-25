/**
 * Test support: answer `fetch` in process, so a test of an HTTP client
 * needs no listening socket. The handler has the shape `Bun.serve` takes,
 * so a stub server becomes a stand-in by handing its handler over.
 */

import { spyOn } from "bun:test";

/** The port and base URL the code under test is pointed at. Nothing binds them. */
export const STAND_IN_PORT = 46999;
export const STAND_IN_BASE_URL = `http://127.0.0.1:${STAND_IN_PORT}`;

const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

/**
 * Replace `fetch` with `handler` for the length of `fn`. A client's
 * timeout is an abort signal, so the stand-in gives up when the caller's
 * signal fires, as a real request would.
 */
export const withFetch = async (
  handler: (request: Request) => Response | Promise<Response>,
  fn: () => Promise<void>,
) => {
  const answer = (input: string | URL | Request, init?: RequestInit) => {
    // `Request` has one overload per input kind, and none for a URL object.
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    const reply = Promise.resolve().then(() => handler(request));
    const signal = init?.signal;
    return signal ? Promise.race([reply, untilAborted(signal)]) : reply;
  };
  // Bun's `fetch` type also carries `preconnect`; keep the real one.
  const stub = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(answer, { preconnect: globalThis.fetch.preconnect }),
  );
  await fn().finally(() => stub.mockRestore());
};

/** A handler for "nothing is listening": the request fails to connect. */
export const refuseConnection = () =>
  Promise.reject(new Error("ECONNREFUSED: Unable to connect"));
