import { describe, expect, test } from "bun:test";
import { turnContext } from "./turn-context";

const config = {
  serverUrl: "http://localhost",
  apiKey: "key",
  userMemoryDb: ":memory:",
};

const opts = (promptText: string) => ({
  promptText,
  projectPath: "/repo",
  config,
});

const recorder = () => {
  const queries: string[] = [];
  return {
    queries,
    ops: {
      assembleBootContext: async () => "<boot_context />",
      retrieveTurnContext: async (o: { promptText: string }) => {
        queries.push(o.promptText);
        return `<retrieved_context for="${o.promptText}" />`;
      },
    },
  };
};

describe("turnContext", () => {
  test("the session's first request gets the boot block, which covers the first prompt", async () => {
    const { queries, ops } = recorder();
    const turn = { bootDone: false, pendingRetrieval: true };

    expect(await turnContext(turn, opts("first"), ops)).toBe(
      "<boot_context />",
    );
    expect(turn).toEqual({ bootDone: true, pendingRetrieval: false });
    expect(queries).toEqual([]);
  });

  test("each later prompt is retrieved against once, on its first request", async () => {
    const { queries, ops } = recorder();
    const turn = { bootDone: true, pendingRetrieval: true };

    expect(await turnContext(turn, opts("how does sync work"), ops)).toBe(
      '<retrieved_context for="how does sync work" />',
    );
    // The same turn's later requests (tool rounds) retrieve nothing more.
    expect(await turnContext(turn, opts("how does sync work"), ops)).toBeNull();
    expect(queries).toEqual(["how does sync work"]);
  });

  test("a prompt with no text retrieves nothing", async () => {
    const { queries, ops } = recorder();
    const turn = { bootDone: true, pendingRetrieval: true };

    expect(await turnContext(turn, opts("  \n"), ops)).toBeNull();
    expect(turn.pendingRetrieval).toBe(false);
    expect(queries).toEqual([]);
  });
});
