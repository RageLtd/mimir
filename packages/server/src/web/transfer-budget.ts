export const SINGLE_DATAGRAM_TARGET_BYTES = 1_000;
export const COLD_LOAD_BUDGET_BYTES = 10 * 1_024;

type TransferEncoding = "identity" | "gzip";
type ResourceKind = "html" | "css" | "javascript" | "image" | "font" | "other";

interface CriticalResource {
  path: string;
  kind: ResourceKind;
}

interface TransferEntry extends CriticalResource {
  bodyBytes: number;
  headerBytes: number;
  transferBytes: number;
  servedEncoding: string;
}

type WebFetcher = (
  path: string,
  init?: RequestInit,
) => Response | Promise<Response>;

const BASE_URL = "https://mimir.local";
const encoder = new TextEncoder();

function parseAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const pattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function srcsetCandidates(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .flatMap((candidate) => (candidate ? [candidate] : []));
}

function preloadKind(value: string | undefined) {
  switch (value?.toLowerCase()) {
    case "style":
      return "css";
    case "script":
      return "javascript";
    case "image":
      return "image";
    case "font":
      return "font";
    default:
      return "other";
  }
}

export function discoverCriticalResources(html: string, route: string) {
  const resources = new Map<string, ResourceKind>();
  const externalResources = new Set<string>();
  const base = new URL(route, BASE_URL);

  const add = (value: string | undefined, kind: ResourceKind) => {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
      return;
    }
    const url = new URL(value, base);
    if (url.origin !== base.origin) {
      externalResources.add(url.href);
      return;
    }
    url.hash = "";
    resources.set(`${url.pathname}${url.search}`, kind);
  };

  const tags = /<(script|link|img|source)\b([^>]*)>/gi;
  for (const match of html.matchAll(tags)) {
    const tag = match[1]?.toLowerCase();
    const attributes = parseAttributes(match[2] ?? "");

    switch (tag) {
      case "script":
        add(attributes.src, "javascript");
        break;
      case "link": {
        const relations = new Set(
          (attributes.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean),
        );
        if (relations.has("stylesheet")) {
          add(attributes.href, "css");
        } else if (relations.has("modulepreload")) {
          add(attributes.href, "javascript");
        } else if (relations.has("preload")) {
          add(attributes.href, preloadKind(attributes.as));
        }
        break;
      }
      case "img":
        if (attributes.loading !== "lazy") {
          add(attributes.src, "image");
          for (const candidate of srcsetCandidates(attributes.srcset)) {
            add(candidate, "image");
          }
        }
        break;
      case "source":
        add(attributes.src, "image");
        for (const candidate of srcsetCandidates(attributes.srcset)) {
          add(candidate, "image");
        }
        break;
    }
  }

  return {
    resources: [...resources].map(([path, kind]) => ({ path, kind })),
    externalResources: [...externalResources],
  };
}

function kindFromContentType(fallback: ResourceKind, contentType: string) {
  if (contentType.includes("text/css")) return "css";
  if (
    contentType.includes("javascript") ||
    contentType.includes("ecmascript")
  ) {
    return "javascript";
  }
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("font/")) return "font";
  return fallback;
}

function responseHeaderBytes(response: Response) {
  // HTTP/2 and HTTP/3 compress fields differently, so there is no stable
  // protocol-independent header byte count. HTTP/1.1 serialization gives
  // the gate a deterministic, conservative estimate using the headers the
  // application actually served; the 1,000-byte target leaves framing room.
  let serialized = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
  for (const [name, value] of response.headers) {
    serialized += `${name}: ${value}\r\n`;
  }
  return encoder.encode(`${serialized}\r\n`).byteLength;
}

async function measureResponse(
  fetcher: WebFetcher,
  resource: CriticalResource,
  requestedEncoding: TransferEncoding,
) {
  const response = await fetcher(resource.path, {
    headers: { "accept-encoding": requestedEncoding },
  });
  if (!response.ok) {
    throw new Error(
      `transfer measurement failed for ${resource.path}: HTTP ${response.status}`,
    );
  }

  const bodyBytes = (await response.arrayBuffer()).byteLength;
  const headerBytes = responseHeaderBytes(response);
  return {
    path: resource.path,
    kind: kindFromContentType(
      resource.kind,
      response.headers.get("content-type") ?? "",
    ),
    bodyBytes,
    headerBytes,
    transferBytes: bodyBytes + headerBytes,
    servedEncoding: response.headers.get("content-encoding") ?? "identity",
  } satisfies TransferEntry;
}

export async function measureFirstLoad(
  fetcher: WebFetcher,
  route: string,
  requestedEncoding: TransferEncoding,
) {
  const discoveryResponse = await fetcher(route, {
    headers: { "accept-encoding": "identity" },
  });
  if (!discoveryResponse.ok) {
    throw new Error(
      `transfer discovery failed for ${route}: HTTP ${discoveryResponse.status}`,
    );
  }
  const contentType = discoveryResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(
      `transfer discovery expected HTML for ${route}, received ${contentType || "no content type"}`,
    );
  }

  const discovered = discoverCriticalResources(
    await discoveryResponse.text(),
    route,
  );
  const entries: TransferEntry[] = [];
  entries.push(
    await measureResponse(
      fetcher,
      { path: route, kind: "html" },
      requestedEncoding,
    ),
  );
  for (const resource of discovered.resources) {
    entries.push(await measureResponse(fetcher, resource, requestedEncoding));
  }

  const bytesByKind: Record<ResourceKind, number> = {
    html: 0,
    css: 0,
    javascript: 0,
    image: 0,
    font: 0,
    other: 0,
  };
  for (const entry of entries) {
    bytesByKind[entry.kind] += entry.transferBytes;
  }

  const totalBytes = entries.reduce(
    (total, entry) => total + entry.transferBytes,
    0,
  );
  const requestCount = entries.length;
  const hardLimitMet =
    totalBytes <= COLD_LOAD_BUDGET_BYTES &&
    discovered.externalResources.length === 0;
  const singleDatagramMet =
    totalBytes <= SINGLE_DATAGRAM_TARGET_BYTES &&
    requestCount === 1 &&
    bytesByKind.javascript === 0 &&
    discovered.externalResources.length === 0;

  return {
    route,
    requestedEncoding,
    entries,
    externalResources: discovered.externalResources,
    bytesByKind,
    requestCount,
    totalBytes,
    hardLimitBytes: COLD_LOAD_BUDGET_BYTES,
    hardLimitMet,
    singleDatagramTargetBytes: SINGLE_DATAGRAM_TARGET_BYTES,
    singleDatagramMet,
  };
}

export function assertTransferBudget(
  report: Awaited<ReturnType<typeof measureFirstLoad>>,
) {
  if (report.hardLimitMet) return;
  const external = report.externalResources.length
    ? `; external resources: ${report.externalResources.join(", ")}`
    : "";
  throw new Error(
    `${report.route} cold load is ${report.totalBytes} bytes; budget is ${report.hardLimitBytes}${external}`,
  );
}
