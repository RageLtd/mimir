import { describe, expect, test } from "bun:test";
import { isPublicWebPath, safeReturnTo, signInLocation } from "./paths";

describe("public web paths", () => {
  test("keeps page exemptions exact and asset exemptions namespaced", () => {
    expect(isPublicWebPath("/")).toBe(true);
    expect(isPublicWebPath("/sign-in")).toBe(true);
    expect(isPublicWebPath("/sign-up")).toBe(true);
    expect(isPublicWebPath("/assets/app.css")).toBe(true);
    expect(isPublicWebPath("/sign-in/")).toBe(false);
    expect(isPublicWebPath("/assets")).toBe(false);
    expect(isPublicWebPath("/assets-private/app.css")).toBe(false);
    expect(isPublicWebPath("/v1/sign-in")).toBe(false);
  });
});

describe("return targets", () => {
  test("accepts origin-local paths with query strings", () => {
    expect(safeReturnTo("/app/settings?tab=profile")).toBe(
      "/app/settings?tab=profile",
    );
  });

  test("normalizes external, malformed, and missing values", () => {
    expect(safeReturnTo(undefined)).toBe("/app");
    expect(safeReturnTo("https://example.com/steal")).toBe("/app");
    expect(safeReturnTo("//example.com/steal")).toBe("/app");
    expect(safeReturnTo("/\\example.com/steal")).toBe("/app");
    expect(safeReturnTo("/app\nset-cookie: bad")).toBe("/app");
  });

  test("encodes the protected request into the sign-in location", () => {
    expect(signInLocation("https://mimir.test/app/devices?sort=new")).toBe(
      "/sign-in?returnTo=%2Fapp%2Fdevices%3Fsort%3Dnew",
    );
  });
});
