import { describe, expect, test } from "bun:test";
import { getServerTools } from "./index";
import { executeTodoWrite, planTools } from "./plan";

describe("TodoWrite plan tool", () => {
  test("execute acknowledges the recorded item count", async () => {
    const result = await executeTodoWrite({
      todos: [
        { content: "Read the file", status: "completed" },
        {
          content: "Apply the fix",
          status: "in_progress",
          activeForm: "Applying the fix",
        },
      ],
    });
    expect(result).toContain("2 items");
  });

  test("execute uses singular wording for a single item", async () => {
    const result = await executeTodoWrite({
      todos: [{ content: "Ship it", status: "pending" }],
    });
    expect(result).toContain("1 item");
    expect(result).not.toContain("1 items");
  });

  test("is offered to the model as a server tool, so the loop executes it server-side", () => {
    // Membership in getServerTools() IS the classification — the loop
    // classifies tool calls against ctx.serverTools directly.
    expect("TodoWrite" in getServerTools()).toBe(true);
    expect("TodoWrite" in planTools).toBe(true);
  });
});
