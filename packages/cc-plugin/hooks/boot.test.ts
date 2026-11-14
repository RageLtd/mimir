import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/t";
const CWD = "/work/repo";
const SESSION = "sess-1";
const BLOCK =
  "<boot_context>\n<user_profile_section>Rage</user_profile_section>\n</boot_context>";
const ENGINE_BLOCKS = [{ name: "claudeMd", text: "# rules" }];

type Run = { argv: readonly string[]; stdin?: string; env?: object };

const exited = (exitCode: number, stdout = "") => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

test("runs mimir-cc boot-context with the session's cwd and appends its block after the engine's", async ($, on) => {
  mock.env(on, { HOME });
  on("session.cwd", () => ({ value: CWD }));
  on("session.id", () => ({ value: SESSION }));
  const runs: Run[] = [];
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    return exited(0, `${BLOCK}\n`);
  });
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));

  const { blocks } = await $.prompt.context({ blocks: ENGINE_BLOCKS });

  expect(runs).toEqual([
    {
      argv: [`${HOME}/.local/bin/mimir-cc`, "boot-context"],
      stdin: JSON.stringify({ cwd: CWD, session_id: SESSION }),
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(blocks).toEqual([
    ...ENGINE_BLOCKS,
    { name: "mimirBoot", text: BLOCK },
  ]);
});

test("leaves the engine's blocks alone when the binary has nothing to add", async ($, on) => {
  mock.env(on, { HOME });
  on("session.cwd", () => ({ value: CWD }));
  on("session.id", () => ({ value: SESSION }));
  on("process.run", () => exited(0));
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));

  const { blocks } = await $.prompt.context({ blocks: ENGINE_BLOCKS });

  expect(blocks).toEqual(ENGINE_BLOCKS);
});

test("fails open when the binary exits non-zero", async ($, on) => {
  mock.env(on, { HOME });
  on("session.cwd", () => ({ value: CWD }));
  on("session.id", () => ({ value: SESSION }));
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("process.run", () => exited(3));
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));

  const { blocks } = await $.prompt.context({ blocks: ENGINE_BLOCKS });

  expect(blocks).toEqual(ENGINE_BLOCKS);
  expect(statuses).toEqual(["mimir: boot context failed (exit 3)"]);
});

test("fails open when the binary cannot be run at all", async ($, on) => {
  mock.env(on, { HOME });
  on("session.cwd", () => ({ value: CWD }));
  on("session.id", () => ({ value: SESSION }));
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("process.run", () => {
    throw new Error("ENOENT");
  });
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));

  const { blocks } = await $.prompt.context({ blocks: ENGINE_BLOCKS });

  expect(blocks).toEqual(ENGINE_BLOCKS);
  expect(statuses).toEqual(["mimir: boot context failed"]);
});
