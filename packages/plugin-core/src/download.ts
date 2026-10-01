/**
 * Streaming HTTP download with a stall watchdog — shared by every
 * installer that pulls a release artifact (llama.cpp, the GGUF,
 * cartographer). Lifted out of brain/embedder-install when cartographer
 * became the second consumer.
 */

/** Abort when zero bytes arrive for this long. A rolling deadline, not an
 *  overall one — slow links are fine, dead connections are not. (Learned
 *  live: a wedged CDN connection stalled a signal-less fetch forever.) */
export const DOWNLOAD_STALL_MS = 30_000;

export const downloadTo = async (
  url: string,
  dest: string,
  stallMs: number = DOWNLOAD_STALL_MS,
) => {
  const controller = new AbortController();
  const stalled = () =>
    controller.abort(new Error(`download stalled ${stallMs}ms: ${url}`));
  let watchdog = setTimeout(stalled, stallMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    }
    if (!res.body) throw new Error(`download failed: empty body for ${url}`);

    // Stream to disk chunk-by-chunk, resetting the watchdog per chunk —
    // an interrupted run leaves a partial the next attempt overwrites.
    const writer = Bun.file(dest).writer();
    for await (const chunk of res.body) {
      clearTimeout(watchdog);
      watchdog = setTimeout(stalled, stallMs);
      writer.write(chunk);
    }
    await writer.end();
  } finally {
    clearTimeout(watchdog);
  }
};
