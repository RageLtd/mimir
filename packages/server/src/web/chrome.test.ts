import { describe, expect, test } from "bun:test";
import { web } from ".";

describe("dashboard chrome", () => {
  test("renders the public shell as semantic, zero-runtime HTML", async () => {
    const response = await web.request("/sign-in");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>Sign in — Mimir</title>");
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<a class="skip" href="#main">');
    expect(html).toContain('<header class="site-head">');
    expect(html).toContain('<nav class="head-nav" aria-label="Account">');
    expect(html).toContain('<main id="main" class="content">');
    expect(html).toContain("<footer class=");
    expect(html).toContain("system-ui");
    expect(html).toContain(":focus-visible");
    expect(html).toContain("@media(min-width:48rem)");
    expect(html).toContain('<form class="auth-form" method="post" action="/sign-in">');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain("required");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('rel="stylesheet"');
  });

  test("normalizes unsafe return targets before rendering auth links", async () => {
    const response = await web.request(
      "/sign-in?returnTo=https%3A%2F%2Fexample.com%2Fsteal",
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("returnTo=%2Fapp");
    expect(html).not.toContain("example.com");
  });

  test("renders a semantic first-claim and invited-user sign-up form", async () => {
    const response = await web.request("/sign-up");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<form class="auth-form" method="post" action="/sign-up">');
    expect(html).toContain('<label for="sign-up-name">');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('name="setupToken"');
    expect(html).not.toContain("<script");
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
