FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run build:web

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS production
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS runtime
WORKDIR /app
# Use current Debian security fixes for curl and git; exact versions would require a snapshot mirror.
RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*
COPY --from=production /app/apps ./apps
COPY --from=production /app/packages ./packages
COPY --from=production /app/node_modules ./node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Startup version checks, the migration one-shot and blob bootstrap share this image.
COPY db/migrations ./db/migrations
COPY db/migrations.ts db/sql-migration-runner.ts db/migrate-cli.ts ./db/
# The server imports its SQL modules from db/internal at runtime.
COPY db/internal ./db/internal
COPY infra/init/blobs ./infra/init/blobs
# The bp CLI (compose.enroll.yaml) reads the OpenAPI contract and the generated command table.
COPY contracts/openapi ./contracts/openapi
COPY tooling/codegen/commands.ts ./tooling/codegen/commands.ts
RUN mkdir /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=30 CMD curl -fsS http://localhost:3000/health/ready || exit 1
CMD ["bun", "apps/server/main.ts"]
