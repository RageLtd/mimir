import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionVoiceAnchor } from "@mimir/plugin-core/voice-anchor";
import {
  anchorFor,
  parseAnchorArgs,
  runVoiceAnchorCommand,
} from "./voice-anchor";

const LIBRARY = [
  { title: "a", body: "> Mimir: one" },
  { title: "b", body: "> Mimir: two" },
  { title: "c", body: "> Mimir: three" },
];

const PROMPT = `# Mimir

## Voice in Action

**Noticing something:**

> Mimir: Now that's a tidy bit of work, brother.

**Pushing back:**

> Developer: Let's just duplicate it.
>
> Mimir: Bollocks to "refactor later".
`;

describe("parseAnchorArgs", () => {
  test("reads --session and --nth", () => {
    expect(parseAnchorArgs(["--session", "s1", "--nth", "4"])).toEqual({
      session: "s1",
      nth: 4,
    });
  });

  test.each([
    [[]],
    [["--session", "s1"]],
    [["--nth", "1"]],
    [["--session", "s1", "--nth", "-1"]],
    [["--session", "s1", "--nth", "x"]],
    [["--session"]],
    [["--bogus", "1"]],
  ])("rejects %j", (argv) => {
    expect(parseAnchorArgs(argv)).toHaveProperty("error");
  });
});

describe("anchorFor", () => {
  test("walks the library from the session's hashed start, wrapping", () => {
    const start = createSessionVoiceAnchor("sess", LIBRARY.length).anchorIndex;
    for (const nth of [0, 1, 2, 3, 7]) {
      expect(anchorFor(LIBRARY, "sess", nth)).toBe(
        LIBRARY[(start + nth) % LIBRARY.length] ?? null,
      );
    }
  });

  test("different sessions start at different offsets", () => {
    const starts = new Set(
      ["a", "b", "c", "d", "e", "f"].map(
        (session) => anchorFor(LIBRARY, session, 0)?.body,
      ),
    );
    expect(starts.size).toBeGreaterThan(1);
  });

  test("an empty library yields nothing", () => {
    expect(anchorFor([], "sess", 0)).toBeNull();
  });
});

describe("runVoiceAnchorCommand", () => {
  const saved = {
    MIMIR_HOME: process.env.MIMIR_HOME,
    MIMIR_ACTIVE: process.env.MIMIR_ACTIVE,
  };
  let home: string;
  let out: string[];
  let write: ReturnType<typeof spyOn>;

  const run = async (home: string, rest: readonly string[]) => {
    process.env.MIMIR_HOME = home;
    process.env.MIMIR_ACTIVE = "1";
    out = [];
    write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      return await runVoiceAnchorCommand(rest);
    } finally {
      write.mockRestore();
    }
  };

  afterEach(async () => {
    process.env.MIMIR_HOME = saved.MIMIR_HOME;
    process.env.MIMIR_ACTIVE = saved.MIMIR_ACTIVE;
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("prints the nth anchor of the installed persona's library", async () => {
    home = await mkdtemp(join(tmpdir(), "mimir-anchor-"));
    await Bun.write(join(home, "system-prompt.md"), PROMPT);

    const first = await run(home, ["--session", "s", "--nth", "0"]);
    const firstOut = out.join("");
    const second = await run(home, ["--session", "s", "--nth", "1"]);
    const secondOut = out.join("");

    expect([first, second]).toEqual([0, 0]);
    expect(firstOut).toStartWith("<voice_anchor>\n");
    expect(firstOut).toEndWith("\n</voice_anchor>");
    expect(secondOut).not.toBe(firstOut);
    expect([firstOut, secondOut].sort()).toEqual(
      [
        "<voice_anchor>\nMimir: Now that's a tidy bit of work, brother.\n</voice_anchor>",
        '<voice_anchor>\nDeveloper: Let\'s just duplicate it.\n\nMimir: Bollocks to "refactor later".\n</voice_anchor>',
      ].sort(),
    );
  });

  test("prints nothing and exits 0 when no persona is installed", async () => {
    home = await mkdtemp(join(tmpdir(), "mimir-anchor-"));
    expect(await run(home, ["--session", "s", "--nth", "0"])).toBe(0);
    expect(out).toEqual([]);
  });

  test("exits 1 when the persona has no voice library", async () => {
    home = await mkdtemp(join(tmpdir(), "mimir-anchor-"));
    await Bun.write(join(home, "system-prompt.md"), "# Mimir\n\nNo voices.\n");
    expect(await run(home, ["--session", "s", "--nth", "0"])).toBe(1);
    expect(out).toEqual([]);
  });

  test("exits 1 on bad arguments", async () => {
    home = await mkdtemp(join(tmpdir(), "mimir-anchor-"));
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(home, ["--nth", "0"])).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
