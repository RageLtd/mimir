import {
  brotliCompressSync,
  constants,
  deflateSync,
  gzipSync,
} from "node:zlib";
import { createMiddleware } from "hono/factory";

export type WebEncoding = "br" | "zstd" | "gzip" | "deflate" | "identity";

const STRENGTH: Exclude<WebEncoding, "identity">[] = [
  "br",
  "zstd",
  "gzip",
  "deflate",
];
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:javascript|json|xml|wasm)|image\/svg\+xml)/i;

function acceptedEncodings(header: string) {
  const accepted = new Map<string, number>();
  for (const item of header.split(",")) {
    const [rawName, ...parameters] = item.trim().toLowerCase().split(";");
    if (!rawName) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(0(?:\.\d{0,3})?|\.\d{1,3}|1(?:\.0{0,3})?)$/.exec(
        parameter.trim(),
      );
      if (match?.[1]) quality = Number(match[1]);
    }
    accepted.set(rawName, quality);
  }
  return accepted;
}

function quality(accepted: Map<string, number>, encoding: string) {
  return accepted.get(encoding) ?? accepted.get("*") ?? 0;
}

function identityAccepted(accepted: Map<string, number>) {
  if (accepted.has("identity")) return (accepted.get("identity") ?? 0) > 0;
  return accepted.get("*") !== 0;
}

export function negotiateWebEncoding(header: string | undefined) {
  if (!header) return "identity" as const;
  const accepted = acceptedEncodings(header);
  const candidates = STRENGTH.map((encoding, strength) => ({
    encoding,
    quality: quality(accepted, encoding),
    strength,
  }))
    .filter((candidate) => candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.strength - b.strength);
  if (candidates[0]) return candidates[0].encoding;
  return identityAccepted(accepted) ? "identity" : null;
}

function compress(
  body: Uint8Array,
  encoding: Exclude<WebEncoding, "identity">,
) {
  if (encoding === "br") {
    return brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      },
    });
  }
  if (encoding === "zstd") {
    return Bun.zstdCompressSync(body, { level: 22 });
  }
  if (encoding === "gzip") return gzipSync(body, { level: 9 });
  return deflateSync(body, { level: 9 });
}

function varyAcceptEncoding(headers: Headers) {
  const values = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add("Accept-Encoding");
  headers.set("vary", [...values].join(", "));
}

export const webCompression = createMiddleware(async (c, next) => {
  await next();
  const response = c.res;
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type") ?? "";
  if (
    c.req.method === "HEAD" ||
    response.status === 204 ||
    response.status === 304 ||
    headers.has("content-encoding") ||
    headers.has("content-range") ||
    headers.get("cache-control")?.includes("no-transform") ||
    !COMPRESSIBLE.test(contentType)
  ) {
    return;
  }

  varyAcceptEncoding(headers);
  const encoding = negotiateWebEncoding(c.req.header("accept-encoding"));
  if (!encoding) {
    c.res = new Response(null, { status: 406, headers });
    return;
  }
  if (encoding === "identity") {
    c.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return;
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const compressed = compress(body, encoding);
  if (
    compressed.byteLength >= body.byteLength &&
    identityAccepted(acceptedEncodings(c.req.header("accept-encoding") ?? ""))
  ) {
    c.res = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return;
  }
  headers.delete("content-length");
  headers.set("content-encoding", encoding);
  c.res = new Response(Uint8Array.from(compressed).buffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
