import { describe, expect, test } from "bun:test";
import {
	type BootContent,
	buildProfileResult,
	buildRulesResult,
	buildSessionContextResult,
	formatBootContent,
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

	test("instructions mention never quoting the block", () => {
		expect(USER_CONTEXT_INSTRUCTIONS).toContain(
			"Never mention this context block",
		);
	});
});

// ── buildRulesResult ──

describe("buildRulesResult", () => {
	test("returns rules content when present", () => {
		const rules = "<project_rules>be excellent</project_rules>";
		const result = buildRulesResult(rules);
		expect(result).toBe(rules);
	});

	test("returns fallback message when content is null", () => {
		const result = buildRulesResult(null);
		expect(result).toContain("No project rules found in this codebase.");
	});
});

// ── buildSessionContextResult ──

describe("buildSessionContextResult", () => {
	test("returns context content when present", () => {
		const ctx = "<conversation_context>...</conversation_context>";
		const result = buildSessionContextResult(ctx);
		expect(result).toBe(ctx);
	});

	test("returns fallback message when content is null", () => {
		const result = buildSessionContextResult(null);
		expect(result).toContain("start of the conversation");
	});
});

// ── formatBootContent ──

describe("formatBootContent", () => {
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

	test("wraps content in boot_context tags", () => {
		const result = formatBootContent(mkContent());
		expect(result.startsWith("<boot_context>")).toBe(true);
		expect(result.endsWith("</boot_context>")).toBe(true);
	});

	test("includes all three sections with XML tags", () => {
		const result = formatBootContent(mkContent());
		expect(result).toContain("<user_profile_section>");
		expect(result).toContain("</user_profile_section>");
		expect(result).toContain("<project_rules_section>");
		expect(result).toContain("</project_rules_section>");
		expect(result).toContain("<session_context_section>");
		expect(result).toContain("</session_context_section>");
	});

	test("includes user context instructions", () => {
		const result = formatBootContent(mkContent());
		expect(result).toContain(USER_CONTEXT_INSTRUCTIONS);
	});

	test("includes user context content", () => {
		const result = formatBootContent(mkContent());
		expect(result).toContain("Name: Test");
	});

	test("includes project rules content", () => {
		const result = formatBootContent(mkContent());
		expect(result).toContain("No OOP.");
	});

	test("includes session context content", () => {
		const result = formatBootContent(mkContent());
		expect(result).toContain("[User]\nhello");
	});

	test("handles all-null content with fallbacks", () => {
		const result = formatBootContent({
			userContext: null,
			projectRules: null,
			sessionContext: null,
		});
		expect(result).toContain("No user profile or memories stored yet");
		expect(result).toContain("No project rules found in this codebase.");
		expect(result).toContain("start of the conversation");
	});

	test("produces identical output from identical input", () => {
		const content = mkContent();
		const a = formatBootContent(content);
		const b = formatBootContent(content);
		expect(a).toBe(b);
	});
});
