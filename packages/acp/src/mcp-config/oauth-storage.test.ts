import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOAuthStorage, readStoredAccessToken } from "./oauth-storage";

const TMP = join(import.meta.dir, ".tmp-oauth-storage-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  Bun.env.MIMIR_OAUTH_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete Bun.env.MIMIR_OAUTH_DIR;
});

describe("createOAuthStorage", () => {
  test("clientInformation returns undefined when no client.json on disk", async () => {
    const storage = createOAuthStorage({
      serverName: "fresh",
      redirectUrl: "http://localhost:1234/callback",
    });
    expect(await storage.clientInformation()).toBeUndefined();
  });

  test("saveClientInformation persists, clientInformation reads it back", async () => {
    const storage = createOAuthStorage({
      serverName: "roundtrip",
      redirectUrl: "http://localhost:1234/callback",
    });
    await storage.saveClientInformation?.({
      client_id: "abc",
      client_secret: "shh",
    });
    expect(await storage.clientInformation()).toEqual({
      client_id: "abc",
      client_secret: "shh",
    });
  });

  test("tokens returns undefined when no tokens.json on disk", async () => {
    const storage = createOAuthStorage({
      serverName: "no-tokens",
      redirectUrl: "http://localhost:1234/callback",
    });
    expect(await storage.tokens()).toBeUndefined();
  });

  test("saveTokens persists, tokens reads it back", async () => {
    const storage = createOAuthStorage({
      serverName: "tok",
      redirectUrl: "http://localhost:1234/callback",
    });
    await storage.saveTokens({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
    });
    expect(await storage.tokens()).toEqual({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
    });
  });

  test("codeVerifier roundtrip via saveCodeVerifier", async () => {
    const storage = createOAuthStorage({
      serverName: "pkce",
      redirectUrl: "http://localhost:1234/callback",
    });
    await storage.saveCodeVerifier("verifier-string-here");
    expect(await storage.codeVerifier()).toBe("verifier-string-here");
  });

  test("codeVerifier returns empty string when no verifier on disk", async () => {
    const storage = createOAuthStorage({
      serverName: "missing",
      redirectUrl: "http://localhost:1234/callback",
    });
    expect(await storage.codeVerifier()).toBe("");
  });

  test("redirectToAuthorization invokes onRedirect callback", async () => {
    let captured: URL | undefined;
    const storage = createOAuthStorage({
      serverName: "redir",
      redirectUrl: "http://localhost:1234/callback",
      onRedirect: (url) => {
        captured = url;
      },
    });
    const target = new URL("https://example.com/authorize?foo=bar");
    await storage.redirectToAuthorization(target);
    expect(captured?.toString()).toBe(target.toString());
  });

  test("invalidateCredentials('tokens') deletes only tokens.json", async () => {
    const storage = createOAuthStorage({
      serverName: "invtok",
      redirectUrl: "http://localhost:1234/callback",
    });
    await storage.saveClientInformation?.({ client_id: "x" });
    await storage.saveTokens({ access_token: "y", token_type: "Bearer" });
    await storage.invalidateCredentials?.("tokens");
    expect(await storage.tokens()).toBeUndefined();
    expect(await storage.clientInformation()).toEqual({ client_id: "x" });
  });

  test("invalidateCredentials('all') deletes client, tokens, and verifier", async () => {
    const storage = createOAuthStorage({
      serverName: "invall",
      redirectUrl: "http://localhost:1234/callback",
    });
    await storage.saveClientInformation?.({ client_id: "x" });
    await storage.saveTokens({ access_token: "y", token_type: "Bearer" });
    await storage.saveCodeVerifier("z");
    await storage.invalidateCredentials?.("all");
    expect(await storage.clientInformation()).toBeUndefined();
    expect(await storage.tokens()).toBeUndefined();
    expect(await storage.codeVerifier()).toBe("");
  });

  test("clientMetadata reflects redirectUrl", () => {
    const storage = createOAuthStorage({
      serverName: "meta",
      redirectUrl: "http://localhost:9999/callback",
    });
    expect(storage.clientMetadata.redirect_uris).toEqual([
      "http://localhost:9999/callback",
    ]);
    expect(storage.clientMetadata.grant_types).toContain("authorization_code");
  });

  test("malformed tokens.json returns undefined with warning", async () => {
    const dir = join(TMP, "malformed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tokens.json"), "{ not valid");
    const storage = createOAuthStorage({
      serverName: "malformed",
      redirectUrl: "http://localhost:1234/callback",
    });
    expect(await storage.tokens()).toBeUndefined();
  });
});

describe("readStoredAccessToken", () => {
  test("returns null when no tokens persisted", async () => {
    expect(await readStoredAccessToken("nope")).toBeNull();
  });

  test("returns access_token when persisted", async () => {
    const dir = join(TMP, "preauth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tokens.json"),
      JSON.stringify({ access_token: "secret", token_type: "Bearer" }),
    );
    expect(await readStoredAccessToken("preauth")).toBe("secret");
  });

  test("returns null when access_token field is missing", async () => {
    const dir = join(TMP, "noat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tokens.json"),
      JSON.stringify({ refresh_token: "r", token_type: "Bearer" }),
    );
    expect(await readStoredAccessToken("noat")).toBeNull();
  });
});
