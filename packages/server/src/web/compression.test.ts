import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { negotiateWebEncoding, webCompression } from "./compression";

describe("web content negotiation", () => {
  test("prefers the strongest equally weighted encoding", () => {
    expect(negotiateWebEncoding("gzip, deflate, br, zstd")).toBe("br");
  });

  test("honors client quality weights before server preference", () => {
    expect(negotiateWebEncoding("br;q=.5, zstd;q=.8, gzip;q=1")).toBe("gzip");
  });

  test("falls through every supported coding and finally identity", () => {
    expect(negotiateWebEncoding("zstd")).toBe("zstd");
    expect(negotiateWebEncoding("gzip")).toBe("gzip");
    expect(negotiateWebEncoding("deflate")).toBe("deflate");
    expect(negotiateWebEncoding("identity")).toBe("identity");
    expect(negotiateWebEncoding(undefined)).toBe("identity");
  });

  test("returns no representation when every coding is forbidden", () => {
    expect(negotiateWebEncoding("*;q=0, identity;q=0")).toBeNull();
  });
});

describe("web compression middleware", () => {
  const app = new Hono();
  app.use("*", webCompression);
  app.get("/", (c) =>
    c.body("Mimir remembers. ".repeat(300), {
      headers: { "content-type": "text/plain; charset=UTF-8" },
    }),
  );

  test("serves the best coding the browser advertises", async () => {
    for (const encoding of ["br", "zstd", "gzip", "deflate"]) {
      const response = await app.request("/", {
        headers: { "accept-encoding": encoding },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(response.headers.get("vary")).toContain("Accept-Encoding");
      expect((await response.arrayBuffer()).byteLength).toBeLessThan(300);
    }
  });

  test("keeps identity when compression is not advertised", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toStartWith("Mimir remembers.");
  });

  test("returns 406 when the client forbids every representation", async () => {
    const response = await app.request("/", {
      headers: { "accept-encoding": "*;q=0, identity;q=0" },
    });
    expect(response.status).toBe(406);
  });
});
