FROM oven/bun:alpine AS build
WORKDIR /app

# Workspace skeleton: root manifest defines the dependency catalogs, bun.lock
# pins resolved versions, member manifests complete the graph so `catalog:`
# references resolve. Built from the monorepo root context.
#
# The tsconfigs are part of the build inputs, not just editor config: the web
# surface is Hono JSX, and `jsxImportSource: "hono/jsx"` lives in the root
# tsconfig with the server's extending it. Without both files present, Bun
# falls back to the default React transform and the compile dies on
# `Could not resolve: "react/jsx-dev-runtime"`.
COPY package.json bun.lock tsconfig.json ./
COPY packages/server/package.json packages/server/tsconfig.json packages/server/
COPY packages/acp/package.json packages/acp/
COPY packages/cc-plugin/package.json packages/cc-plugin/
COPY packages/oc-plugin/package.json packages/oc-plugin/
COPY packages/plugin-core/package.json packages/plugin-core/
RUN bun install

COPY packages/server/src packages/server/src

WORKDIR /app/packages/server
RUN bun build src/index.ts --compile --outfile /app/mimir-server

FROM oven/bun:alpine
WORKDIR /app

COPY --from=build /app/mimir-server .

EXPOSE 8080

CMD ["./mimir-server"]
