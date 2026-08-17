# =============================================================================
# Mimi Chicken OS Backend - Multi-stage Dockerfile
# =============================================================================

# --- Base stage ---
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# --- Dependencies stage ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sync-protocol/package.json ./packages/sync-protocol/
RUN pnpm install --frozen-lockfile

# --- Development stage ---
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sync-protocol/node_modules ./packages/sync-protocol/node_modules
COPY . .
WORKDIR /app/apps/backend
EXPOSE 4000
CMD ["pnpm", "dev"]

# --- Build stage ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sync-protocol/node_modules ./packages/sync-protocol/node_modules
COPY . .
RUN pnpm --filter @mimi/shared build && \
    pnpm --filter @mimi/sync-protocol build && \
    pnpm --filter @mimi/backend build

# Guard against a silently empty build (the incident this Dockerfile exists
# to prevent): a stale/misplaced tsc incremental cache can make `tsc`/`nest
# build` exit 0 while emitting zero files, which used to produce an image
# that COPYs an empty (or absent) dist/ and boots nothing. Fail the image
# build loudly instead of shipping that.
RUN set -e; \
    if [ ! -s /app/apps/backend/dist/main.js ]; then \
      echo "BUILD GUARD FAILED: apps/backend/dist/main.js is missing or empty" >&2; exit 1; \
    fi; \
    if [ -z "$(find /app/packages/shared/dist -name '*.js' -print -quit)" ]; then \
      echo "BUILD GUARD FAILED: packages/shared/dist has no compiled output" >&2; exit 1; \
    fi; \
    if [ -z "$(find /app/packages/sync-protocol/dist -name '*.js' -print -quit)" ]; then \
      echo "BUILD GUARD FAILED: packages/sync-protocol/dist has no compiled output" >&2; exit 1; \
    fi; \
    echo "Build guard OK: backend dist/main.js and sibling package dist/ are populated."

# --- Production stage ---
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# Copy all build artifacts with workspace structure intact
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/package.json ./apps/backend/
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/sync-protocol ./packages/sync-protocol
COPY --from=build /app/package.json ./

# Replace workspace symlinks with actual content for @mimi/shared and @mimi/sync-protocol
RUN rm -rf /app/apps/backend/node_modules/@mimi/shared /app/node_modules/@mimi/shared 2>/dev/null; \
    rm -rf /app/apps/backend/node_modules/@mimi/sync-protocol /app/node_modules/@mimi/sync-protocol 2>/dev/null; \
    mkdir -p /app/node_modules/@mimi /app/apps/backend/node_modules/@mimi && \
    cp -r /app/packages/shared /app/node_modules/@mimi/shared && \
    cp -r /app/packages/shared /app/apps/backend/node_modules/@mimi/shared && \
    cp -r /app/packages/sync-protocol /app/node_modules/@mimi/sync-protocol && \
    cp -r /app/packages/sync-protocol /app/apps/backend/node_modules/@mimi/sync-protocol

WORKDIR /app/apps/backend
EXPOSE 4000
CMD ["node", "dist/main.js"]
