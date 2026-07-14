import { fileURLToPath } from "node:url";

const entries = {
  credentials: fileURLToPath(
    new URL("./browser/credential-entry.ts", import.meta.url),
  ),
  memories: fileURLToPath(
    new URL("./browser/memories-element.ts", import.meta.url),
  ),
  members: fileURLToPath(new URL("./browser/member-entry.ts", import.meta.url)),
};

const builds = new Map<keyof typeof entries, Promise<string>>();

export function buildIsland(name: keyof typeof entries) {
  const existing = builds.get(name);
  if (existing) return existing;
  const build = Bun.build({
    entrypoints: [entries[name]],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
  }).then(async (result) => {
    if (!result.success || !result.outputs[0]) {
      throw new Error(`failed to build ${name} island`);
    }
    return result.outputs[0].text();
  });
  builds.set(name, build);
  return build;
}

export async function credentialIslandResponse() {
  return new Response(await buildIsland("credentials"), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/javascript; charset=UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function memoryIslandResponse() {
  return new Response(await buildIsland("memories"), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/javascript; charset=UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function memberIslandResponse() {
  return new Response(await buildIsland("members"), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/javascript; charset=UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}
