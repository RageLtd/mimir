FROM oven/bun:alpine AS build
WORKDIR /app

# Workspace skeleton: root manifest defines the dependency catalogs, bun.lock
# pins resolved versions, member manifests complete the graph so `catalog:`
# references resolve. Built from the monorepo root context.
COPY package.json bun.lock ./
COPY packages/server/package.json packages/server/
COPY packages/acp/package.json packages/acp/
COPY packages/cc-plugin/package.json packages/cc-plugin/
RUN bun install

COPY packages/server/src packages/server/src

WORKDIR /app/packages/server
RUN bun build src/index.ts --compile --outfile /app/mimir-server

FROM oven/bun:alpine
WORKDIR /app

COPY --from=build /app/mimir-server .

EXPOSE 8080

CMD ["./mimir-server"]
