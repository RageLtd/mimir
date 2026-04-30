/**
 * Slash-command parser tests.
 *
 * Lean coverage focused on the command parsing surface — execution lives
 * in commands.ts and is exercised through integration. Adding cases here
 * is the simplest way to confirm a new slash command is wired correctly.
 */

import { describe, expect, test } from "bun:test";
import { parseCommand } from "./session";

describe("parseCommand", () => {
  test("returns null for non-slash text", () => {
    expect(parseCommand("hello there")).toBeNull();
  });

  test("parses /model with id", () => {
    expect(parseCommand("/model claude-code/sonnet")).toEqual({
      type: "model",
      modelId: "claude-code/sonnet",
    });
  });

  test("parses /compact and its alias /clear", () => {
    expect(parseCommand("/compact")).toEqual({ type: "compact" });
    expect(parseCommand("/clear")).toEqual({ type: "compact" });
  });

  test("parses /mcp list", () => {
    expect(parseCommand("/mcp list")).toEqual({ type: "mcp_list" });
  });

  test("parses /mcp reload", () => {
    expect(parseCommand("/mcp reload")).toEqual({ type: "mcp_reload" });
  });

  test("parses /mcp auth with server name", () => {
    expect(parseCommand("/mcp auth notion")).toEqual({
      type: "mcp_auth",
      name: "notion",
    });
  });

  test("parses /mcp subcommands case-insensitively", () => {
    expect(parseCommand("/MCP LIST")).toEqual({ type: "mcp_list" });
    expect(parseCommand("/Mcp Reload")).toEqual({ type: "mcp_reload" });
    expect(parseCommand("/mcp AUTH github")).toEqual({
      type: "mcp_auth",
      name: "github",
    });
  });

  test("parses /mcp auth with empty name when omitted", () => {
    expect(parseCommand("/mcp auth")).toEqual({ type: "mcp_auth", name: "" });
  });

  test("returns null for /mcp without subcommand", () => {
    expect(parseCommand("/mcp")).toBeNull();
  });

  test("returns null for /mcp with unknown subcommand", () => {
    expect(parseCommand("/mcp bogus")).toBeNull();
  });

  test("parses /memory subcommands", () => {
    expect(parseCommand("/memory search foo bar")).toEqual({
      type: "memory_search",
      query: "foo bar",
    });
    expect(parseCommand("/memory list")).toEqual({ type: "memory_list" });
    expect(parseCommand("/memory store remember this")).toEqual({
      type: "memory_store",
      fact: "remember this",
    });
    expect(parseCommand("/memory delete 42")).toEqual({
      type: "memory_delete",
      id: "42",
    });
  });

  test("returns null for unknown commands", () => {
    expect(parseCommand("/wat")).toBeNull();
  });

  test("trims leading whitespace before parsing", () => {
    expect(parseCommand("  /mcp reload")).toEqual({ type: "mcp_reload" });
  });
});
