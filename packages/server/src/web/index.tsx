import { Hono } from "hono";
import { compress } from "hono/compress";
import { jsxRenderer } from "hono/jsx-renderer";

export const web = new Hono();

web.use("*", compress({ threshold: 0 }));
web.use(
  "*",
  jsxRenderer(({ children }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Mimir</title>
      </head>
      <body>{children}</body>
    </html>
  )),
);

web.get("/", (c) =>
  c.render(
    <main>
      <h1>Mimir</h1>
    </main>,
  ),
);
