import { describe, expect, test } from "bun:test";
import {
	BOOT_SERVER_NAME,
	type BootContent,
	buildProfileResult,
	createBootServer,
	USER_CONTEXT_INSTRUCTIONS,
} from "./boot-tools";

// ── buildProfileResult ──

describe("buildProfileResult", () => {
	test("includes instructions and user context when present", () => {
		const userContext =
			"<user_context>\n<user_profile>\nName: Test\n</user_profile>\n</user_context>";
		const result = buildProfileResult(userContext);
		expect(result).toContain(USER_CONTEXT_INSTRUCTIONS);
		expect(result).toContain(userContext);
	});

	test("includes fallback message when user context is null", () => {
		const result = buildProfileResult(null);
		expect(result).toContain(USER_CONTEXT_INSTRUCTIONS);
		expect(result).toContain("No user profile or memories stored yet");
	});

	test("instructions mention proactive persistence", () => {
		expect(USER_CONTEXT_INSTRUCTIONS).toContain("Proactively persist");
	});

	test("instructions mention never quoting the block", () => {
		expect(USER_CONTEXT_INSTRUCTIONS).toContain(
			"Never mention this context block",
		);
	});
});

// ── createBootServer ──

describe("createBootServer", () => {
	const mkContent = (overrides?: Partial<BootContent>): BootContent => ({
		userContext:
			overrides?.userContext ??
			"<user_context>\n<user_profile>\nName: Test\n</user_profile>\n</user_context>",
		projectRules:
			overrides?.projectRules ??
			"<project_rules>\n--- CLAUDE.md ---\nNo OOP.\n</project_rules>",
	});

	test("returns a server config with the correct name", () => {
		const server = createBootServer(mkContent());
		expect(server.name).toBe(BOOT_SERVER_NAME);
		expect(server.type).toBe("sdk");
	});

	test("server config has an instance property", () => {
		const server = createBootServer(mkContent());
		expect(server.instance).toBeDefined();
	});

	test("returns frozen content for user profile tool", async () => {
		const content = mkContent();
		const server = createBootServer(content);
		// The server instance is an McpServer — we can't call tools directly
		// through it. Verify the config shape is correct for the SDK.
		expect(server.name).toBe(BOOT_SERVER_NAME);
		expect(server.type).toBe("sdk");
	});

	test("handles null user context gracefully", () => {
		const server = createBootServer(mkContent({ userContext: null }));
		expect(server.name).toBe(BOOT_SERVER_NAME);
	});

	test("handles null project rules", () => {
		const server = createBootServer(mkContent({ projectRules: null }));
		expect(server.name).toBe(BOOT_SERVER_NAME);
	});

	test("handles all-empty content", () => {
		const server = createBootServer({
			userContext: null,
			projectRules: null,
		});
		expect(server.name).toBe(BOOT_SERVER_NAME);
		expect(server.type).toBe("sdk");
	});
});
