import { test, expect, describe } from "bun:test";
import { toCanUseTool } from "./permissions";
import type { RequestToolPermission } from "../types";

const baseSdkOptions = {
  signal: new AbortController().signal,
  toolUseID: "tu_abc",
  title: "Run shell command",
  displayName: "Bash",
  description: "Execute a bash command",
  suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "rm *" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
  ],
};

describe("toCanUseTool", () => {
  test("allow_once → PermissionResult allow, user_temporary", async () => {
    const mockPermission: RequestToolPermission = async () => ({
      allowed: true,
      permanent: false,
    });

    const canUseTool = toCanUseTool(mockPermission);
    const result = await canUseTool("Bash", { command: "ls" }, baseSdkOptions);

    expect(result.behavior).toBe("allow");
    expect(result.toolUseID).toBe("tu_abc");
    expect(result.decisionClassification).toBe("user_temporary");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual({ command: "ls" });
      expect(result.updatedPermissions).toBeUndefined();
    }
  });

  test("allow_always → PermissionResult allow with updatedPermissions", async () => {
    const mockPermission: RequestToolPermission = async () => ({
      allowed: true,
      permanent: true,
    });

    const canUseTool = toCanUseTool(mockPermission);
    const result = await canUseTool("Bash", { command: "ls" }, baseSdkOptions);

    expect(result.behavior).toBe("allow");
    expect(result.decisionClassification).toBe("user_permanent");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual({ command: "ls" });
      expect(result.updatedPermissions).toEqual(baseSdkOptions.suggestions);
    }
  });

  test("allow_always without suggestions → allow without updatedPermissions", async () => {
    const mockPermission: RequestToolPermission = async () => ({
      allowed: true,
      permanent: true,
    });

    const canUseTool = toCanUseTool(mockPermission);
    const result = await canUseTool("Bash", { command: "ls" }, {
      ...baseSdkOptions,
      suggestions: undefined,
    });

    expect(result.behavior).toBe("allow");
    expect(result.decisionClassification).toBe("user_temporary");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual({ command: "ls" });
      expect(result.updatedPermissions).toBeUndefined();
    }
  });

  test("deny → PermissionResult deny with message", async () => {
    const mockPermission: RequestToolPermission = async () => ({
      allowed: false,
      message: "User said no",
    });

    const canUseTool = toCanUseTool(mockPermission);
    const result = await canUseTool("Bash", { command: "rm -rf /" }, baseSdkOptions);

    expect(result.behavior).toBe("deny");
    expect(result.toolUseID).toBe("tu_abc");
    expect(result.decisionClassification).toBe("user_reject");
    if (result.behavior === "deny") {
      expect(result.message).toBe("User said no");
    }
  });

  test("deny without message → uses fallback", async () => {
    const mockPermission: RequestToolPermission = async () => ({
      allowed: false,
    });

    const canUseTool = toCanUseTool(mockPermission);
    const result = await canUseTool("Bash", { command: "rm -rf /" }, baseSdkOptions);

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe("Permission denied");
    }
  });

  test("passes toolName, input, and options through correctly", async () => {
    let capturedRequest: Parameters<RequestToolPermission>[0] | undefined;
    const mockPermission: RequestToolPermission = async (req) => {
      capturedRequest = req;
      return { allowed: true };
    };

    const canUseTool = toCanUseTool(mockPermission);
    await canUseTool("Edit", { file: "foo.ts" }, {
      ...baseSdkOptions,
      toolUseID: "tu_xyz",
      title: "Edit file",
      description: "Modify foo.ts",
    });

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.toolName).toBe("Edit");
    expect(capturedRequest!.input).toEqual({ file: "foo.ts" });
    expect(capturedRequest!.toolCallId).toBe("tu_xyz");
    expect(capturedRequest!.title).toBe("Edit file");
    expect(capturedRequest!.description).toBe("Modify foo.ts");
  });

  test("falls back to toolTitle when SDK title is absent", async () => {
    let capturedRequest: Parameters<RequestToolPermission>[0] | undefined;
    const mockPermission: RequestToolPermission = async (req) => {
      capturedRequest = req;
      return { allowed: true };
    };

    const canUseTool = toCanUseTool(mockPermission);
    await canUseTool("Bash", { command: "ls" }, {
      ...baseSdkOptions,
      title: undefined,
      displayName: "Shell command",
    });

    // toolTitle("Bash", { command: "ls" }) → "ls"
    expect(capturedRequest!.title).toBe("ls");
  });
});
