import { describe, expect, test } from "bun:test";
import { createUserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import {
  cartographerTools,
  hygieneTool,
  installTool,
  userMemoryTools,
} from "./tools";

const context: ToolContext = {
  ...JSON.parse(
    '{"sessionID":"test-tools","messageID":"test-message","agent":"mimir","id":"test-call"}',
  ),
  signal: new AbortController().signal,
  progress: async () => {},
};

describe("V2 custom tools", () => {
  test("publishes native JSON schemas with required, optional, integer and array fields", () => {
    const user = userMemoryTools(null);
    const cart = cartographerTools("/project");
    const install = installTool();
    const hygiene = hygieneTool();
    expect(Object.keys(user)).toEqual([
      "user_memory_search",
      "user_memory_store",
      "user_memory_list",
      "user_memory_delete",
      "user_profile_get",
      "user_profile_add",
      "user_profile_remove",
    ]);
    expect(user.user_memory_delete.input.properties.id).toEqual({
      type: "integer",
      description: "The ID of the memory to delete",
    });
    expect(install.input.required).toEqual(["serverUrl"]);
    expect(hygiene.input.required).toEqual([]);
    expect(cart.cartographer_query.input.required).toEqual(["entry_points"]);
    expect(cart.cartographer_query.input.properties.entry_points).toMatchObject(
      { type: "array", items: { type: "string" } },
    );
    for (const definition of [
      ...Object.values(user),
      ...Object.values(cart),
      install,
      hygiene,
    ]) {
      expect(definition.input.type).toBe("object");
      expect(definition.input.additionalProperties).toBe(false);
      expect(JSON.parse(JSON.stringify(definition.input))).toEqual(
        definition.input,
      );
      for (const field of Object.values(definition.input.properties))
        expect(field).not.toHaveProperty("optional");
    }
  });

  test("preserves unavailable strings inside structured content", async () => {
    expect(
      await userMemoryTools(null).user_memory_list.execute({}, context),
    ).toEqual({
      content:
        "User memory unavailable: store not initialised. Run /mimir-install first.",
    });
  });

  test("preserves local user-memory behavior", async () => {
    const store = createUserMemoryStore(":memory:");
    const tools = userMemoryTools(store);
    await tools.user_memory_store.execute(
      { content: "Prefers local tools" },
      context,
    );
    const result = await tools.user_memory_search.execute(
      { query: "local" },
      context,
    );
    expect(result.content).toContain("Prefers local tools");
    store.close();
  });

  test("validates input before side effects without coercing live or IDs", async () => {
    await expect(
      hygieneTool().execute({ live: "true" }, context),
    ).rejects.toThrow("Invalid tool argument: live");
    await expect(
      userMemoryTools(null).user_memory_delete.execute({ id: 1.5 }, context),
    ).rejects.toThrow("Invalid tool argument: id");
    await expect(installTool().execute({}, context)).rejects.toThrow(
      "Invalid tool argument: serverUrl",
    );
    await expect(
      cartographerTools("/project").cartographer_query.execute(
        { entry_points: [42] },
        context,
      ),
    ).rejects.toThrow("Invalid tool argument: entry_points");
    await expect(
      userMemoryTools(null).user_memory_list.execute(
        { unexpected: "secret-value" },
        context,
      ),
    ).rejects.toThrow("Unknown tool argument: unexpected");
  });
});
