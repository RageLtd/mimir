import { expect, test } from "bun:test";
import { createApp } from "./app";

test("renders the web surface without booting the server or auth stores", async () => {
  const response = await createApp({ authEnabled: false }).request("/");
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(html).toStartWith("<!DOCTYPE html>");
  expect(html).toContain('<html lang="en">');
  expect(html).toContain('<meta charset="utf-8"/>');
  expect(html).toContain("<title>Mimir</title>");
  expect(html).toContain("<main><h1>Mimir</h1></main>");
  expect(html).not.toContain("<script");
});
