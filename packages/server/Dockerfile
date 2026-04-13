FROM oven/bun:alpine AS build
WORKDIR /app

COPY package.json ./
RUN bun install

COPY src/ ./src/
COPY provider-data.json ./provider-data.json

RUN bun build src/index.ts --compile --outfile mimir-server

FROM oven/bun:alpine

WORKDIR /app

RUN apk add --no-cache docker
COPY --from=build /app/mimir-server .

EXPOSE 8080

CMD ["./mimir-server"]
