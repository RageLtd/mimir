import { describe, expect, test } from "bun:test";
import pino from "pino";
import { REDACT_CENSOR, REDACT_PATHS, redactSecret } from "./redact";

describe("redactSecret", () => {
  test("scrubs every occurrence of the secret", () => {
    const msg = "401 from upstream: Bearer sk-abc123 rejected (key sk-abc123)";
    expect(redactSecret(msg, "sk-abc123")).toBe(
      `401 from upstream: Bearer ${REDACT_CENSOR} rejected (key ${REDACT_CENSOR})`,
    );
  });

  test("no secret → passthrough", () => {
    expect(redactSecret("plain error", undefined)).toBe("plain error");
  });
});

describe("pino redaction with REDACT_PATHS", () => {
  // Real pino instance writing to a memory sink — proves the path config
  // actually censors, independent of the preload-mocked app logger.
  const makeLogger = () => {
    const lines: string[] = [];
    const sink = {
      write(line: string) {
        lines.push(line);
      },
    };
    const logger = pino(
      { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } },
      sink,
    );
    return { logger, lines };
  };

  test("top-level and nested apiKey are censored", () => {
    const { logger, lines } = makeLogger();
    logger.info(
      { apiKey: "sk-top", override: { apiKey: "sk-nested" } },
      "resolving",
    );

    const line = lines[0] ?? "";
    expect(line).not.toContain("sk-top");
    expect(line).not.toContain("sk-nested");
    expect(line).toContain(REDACT_CENSOR);
  });

  test("providerOverride.apiKey spread into a log object is censored", () => {
    const { logger, lines } = makeLogger();
    logger.warn(
      { providerOverride: { apiKey: "sk-ctx", provider: "anthropic" } },
      "byok request",
    );

    const line = lines[0] ?? "";
    expect(line).not.toContain("sk-ctx");
    // Non-secret fields survive.
    expect(line).toContain("anthropic");
  });

  test("x-provider-api-key header objects are censored", () => {
    const { logger, lines } = makeLogger();
    logger.info(
      { headers: { "x-provider-api-key": "sk-header", host: "x" } },
      "inbound",
    );

    const line = lines[0] ?? "";
    expect(line).not.toContain("sk-header");
    expect(line).toContain("host");
  });
});
