import { describe, expect, test } from "bun:test";
import {
	BOOT_SERVER_NAME,
	type BootContent,
	buildProfileResult,
	buildRulesResult,
	buildSessionContextResult,
	createBootServer,
	USER_CONTEXT_INSTRUCTIONS,
	VOICE_ANCHOR,
} from "./boot-tools";

// ── buildProfileResult ──

describe("buildProfileResult", () => {
	test("includes instructions and user context when present", () => {
		const userContext =
			"<user_context>\n<user_profile>\nName: Test\n</user_profile>\n</user_context>";
		const result = buildProfileResult(userContext);
		expect(result).toContain(USER_CONTEXT_INSTRUCTIONS);
		expect(result).toContain(userContext);
		expect(result.endsWith(VOICE_ANCHOR)).toBe(true);
	});

	test("includes fallback message when user context is null", () => {
		const result = buildProfileResult(null);
		expect(result).toContain(USER_CONTEXT_INSTRUCTIONS);
		expect(result).toContain("No user profile or memories stored yet");
		expect(result.endsWith(VOICE_ANCHOR)).toBe(true);
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

// ── buildRulesResult ──

describe("buildRulesResult", () => {
	test("returns full rules followed by voice anchor when present", () => {
		const rules = "<project_rules>be excellent</project_rules>";
		const result = buildRulesResult(rules);
		expect(result.startsWith(rules)).toBe(true);
		expect(result.endsWith(VOICE_ANCHOR)).toBe(true);
	});

	test("returns fallback message followed by voice anchor when content is null", () => {
		const result = buildRulesResult(null);
		expect(result).toContain("No project rules found in this codebase.");
		expect(result.endsWith(VOICE_ANCHOR)).toBe(true);
	});
});

// ── buildSessionContextResult ──

describe("buildSessionContextResult", () => {
	test("returns full context followed by voice anchor when present", () => {
		const ctx = "<conversation_context>...</conversation_context>";
		const result = buildSessionContextResult(ctx);
		expect(result.startsWith(ctx)).toBe(true);
		expect(result.endsWith(VOICE_ANCHOR)).toBe(true);
	});

	test("returns fallback message followed by voice anchor when content is null", () => {
		const result = buildSessionContextResult(null);
		expect(result).toContain("start of the conversation");
		expect(result.endsWith(VOICE_ANCHOR)).toBe(true);
	});
});

// ── VOICE_ANCHOR ──

describe("VOICE_ANCHOR", () => {
	test("is wrapped in a voice_reminder tag", () => {
		expect(VOICE_ANCHOR).toContain("<voice_reminder>");
		expect(VOICE_ANCHOR).toContain("</voice_reminder>");
	});

	test("names Mimir explicitly", () => {
		expect(VOICE_ANCHOR).toContain("Mimir");
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
		sessionContext:
			overrides?.sessionContext ??
			"<conversation_context>\n[User]\nhello\n\n[Assistant]\nhi\n</conversation_context>",
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

	test("handles null user context gracefully", () => {
		const server = createBootServer(mkContent({ userContext: null }));
		expect(server.name).toBe(BOOT_SERVER_NAME);
	});

	test("handles null project rules", () => {
		const server = createBootServer(mkContent({ projectRules: null }));
		expect(server.name).toBe(BOOT_SERVER_NAME);
	});

	test("handles null session context", () => {
		const server = createBootServer(mkContent({ sessionContext: null }));
		expect(server.name).toBe(BOOT_SERVER_NAME);
	});

	test("handles all-empty content", () => {
		const server = createBootServer({
			userContext: null,
			projectRules: null,
			sessionContext: null,
		});
		expect(server.name).toBe(BOOT_SERVER_NAME);
		expect(server.type).toBe("sdk");
	});

	// Cache-friendliness invariant: identical input content must produce a
	// server config that the SDK serialises identically across calls.
	test("produces stable surface fields from identical content", () => {
		const content = mkContent();
		const a = createBootServer(content);
		const b = createBootServer(content);
		expect(a.name).toBe(b.name);
		expect(a.type).toBe(b.type);
	});
});
