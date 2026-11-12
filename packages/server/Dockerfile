# The build stage runs on the machine doing the build, whatever architecture
# the image is for, and Bun cross-compiles the binary for the target. So an
# amd64 image built on an arm64 machine runs nothing under emulation: the
# final stage below only copies.
FROM --platform=$BUILDPLATFORM oven/bun:alpine AS build
ARG TARGETARCH
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
# Docker names the architecture amd64 where Bun says x64; arm64 is the same in
# both. musl, because the final stage is Alpine.
RUN case "$TARGETARCH" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=arm64 ;; \
      *) echo "no Bun target for architecture '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
    && bun build src/index.ts --compile \
         --target="bun-linux-${bun_arch}-musl" --outfile /app/mimir-server

FROM oven/bun:alpine
WORKDIR /app

COPY --from=build /app/mimir-server .

EXPOSE 8080

CMD ["./mimir-server"]
