import { describe, expect, test } from "bun:test";
import { web } from ".";

describe("dashboard chrome", () => {
  test("renders the public shell as semantic, zero-runtime HTML", async () => {
    const response = await web.request("/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>Mimir — Private agent memory</title>");
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<a class="skip" href="#main">');
    expect(html).toContain('<header class="site-head">');
    expect(html).toContain('<nav class="head-nav" aria-label="Account">');
    expect(html).toContain('<main id="main" class="content">');
    expect(html).toContain("<footer class=");
    expect(html).toContain("system-ui");
    expect(html).toContain(":focus-visible");
    expect(html).toContain("@media(min-width:48rem)");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('rel="stylesheet"');
  });

  test("renders the application shell with labelled navigation", async () => {
    const response = await web.request("/app");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>Dashboard — Mimir</title>");
    expect(html).toContain('<div class="frame app-frame">');
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<nav aria-label="Dashboard">');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<main id="main" class="content">');
    expect(html).not.toContain("<script");
  });
});
