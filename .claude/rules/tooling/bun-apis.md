---
paths: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.mjs", "*.html"]
---
# Bun Built-ins Over Packages

In a Bun project, reach for the built-in before adding a dependency:

| Instead of | Use |
|---|---|
| `express` | `Bun.serve()` — supports routes, WebSockets, HTTPS |
| `better-sqlite3` | `bun:sqlite` |
| `ioredis` | `Bun.redis` |
| `pg`, `postgres.js` | `Bun.sql` |
| `ws` | the built-in `WebSocket` |
| `execa` | ``Bun.$`ls` `` |
| `dotenv` | nothing — Bun loads `.env` automatically |
| `node:fs` readFile/writeFile | `Bun.file` |
| `jest`, `vitest` | `bun test` |
| `webpack`, `esbuild`, `vite` | `bun build`, or HTML imports for frontends |

## Frontends

Serve HTML through `Bun.serve()` with HTML imports rather than a separate bundler. HTML files can import `.tsx`/`.jsx`/`.js` directly and `<link>` stylesheets; Bun transpiles and bundles them, including React, CSS, and Tailwind. `development: { hmr: true }` gives hot reload.

```ts
import index from "./index.html";

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": { GET: (req) => Response.json({ id: req.params.id }) },
  },
  development: { hmr: true },
});
```

If the project already uses npm or pnpm (`package-lock.json`, `pnpm-lock.yaml`), leave its existing stack alone — this rule applies to Bun projects.
