import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CARTOGRAPHER_REPO,
  cartographerBinaryPath,
  installCartographer,
} from "./install";
import { isExecutableFile } from "./resolve";

/**
 * A stand-in GitHub: the latest-release lookup and the asset download,
 * both on one local server. `tag` and `apiDown` are mutable so a test can
 * stage "a newer release shipped" or "GitHub unreachable".
 */
const github = {
  tag: "v1.2.0",
  apiDown: false,
  downloads: 0,
  server: null as ReturnType<typeof Bun.serve> | null,
};
const BINARY_BODY = "#!/bin/sh\necho cartographer\n";

const origin = () => `http://localhost:${github.server?.port}`;
const opts = () => ({
  apiBaseUrl: origin(),
  downloadBaseUrl: origin(),
  sign: async () => {},
});

let home = "";
let savedHome: string | undefined;
const logged: string[] = [];
const log = (m: string) => {
  logged.push(m);
};

beforeAll(() => {
  github.server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === `/repos/${CARTOGRAPHER_REPO}/releases/latest`) {
        if (github.apiDown) return new Response("down", { status: 503 });
        return Response.json({ tag_name: github.tag });
      }
      const download = `/${CARTOGRAPHER_REPO}/releases/download/`;
      if (pathname.startsWith(download)) {
        const [tag] = pathname.slice(download.length).split("/");
        if (tag !== github.tag)
          return new Response("no such release", { status: 404 });
        github.downloads++;
        return new Response(BINARY_BODY);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  github.server?.stop(true);
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-carto-install-"));
  savedHome = process.env.MIMIR_HOME;
  process.env.MIMIR_HOME = home;
  github.tag = "v1.2.0";
  github.apiDown = false;
  github.downloads = 0;
  logged.length = 0;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe("installCartographer", () => {
  test("fresh machine: downloads the latest release, makes it executable, records the tag", async () => {
    const [err, binary] = await installCartographer(log, opts());
    expect(err).toBeNull();
    expect(binary).toBe(cartographerBinaryPath());
    expect(binary).toBe(join(home, "bin", "cartographer"));
    expect(isExecutableFile(binary ?? "")).toBe(true);
    expect(await Bun.file(binary ?? "").text()).toBe(BINARY_BODY);
    expect(await Bun.file(join(home, "bin", ".cartographer-tag")).text()).toBe(
      "v1.2.0",
    );
    expect(github.downloads).toBe(1);
  });

  test("same tag on a later run: no download", async () => {
    await installCartographer(log, opts());
    const [err] = await installCartographer(log, opts());
    expect(err).toBeNull();
    expect(github.downloads).toBe(1);
    expect(logged.at(-1)).toContain("already installed");
  });

  test("a newer release triggers a re-download", async () => {
    await installCartographer(log, opts());
    github.tag = "v1.3.0";
    const [err] = await installCartographer(log, opts());
    expect(err).toBeNull();
    expect(github.downloads).toBe(2);
    expect(await Bun.file(join(home, "bin", ".cartographer-tag")).text()).toBe(
      "v1.3.0",
    );
  });

  test("release check down with a binary on disk: keeps it and says so", async () => {
    await installCartographer(log, opts());
    github.apiDown = true;
    const [err, binary] = await installCartographer(log, opts());
    expect(err).toBeNull();
    expect(binary).toBe(cartographerBinaryPath());
    expect(logged.at(-1)).toContain("keeping installed v1.2.0");
  });

  test("release check down with nothing on disk: fails the install", async () => {
    github.apiDown = true;
    const [err] = await installCartographer(log, opts());
    expect(err?.message).toContain("no binary is installed");
    expect(err?.message).toContain("HTTP 503");
  });

  test("a missing asset leaves no half-written binary behind", async () => {
    // Lookup says v9 exists; the download endpoint knows only v1.2.0.
    github.server?.stop(true);
    github.server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname.endsWith("/releases/latest"))
          return Response.json({ tag_name: "v9.0.0" });
        return new Response("not found", { status: 404 });
      },
    });
    const [err] = await installCartographer(log, opts());
    expect(err?.message).toContain("HTTP 404");
    expect(await Bun.file(cartographerBinaryPath()).exists()).toBe(false);
  });
});
