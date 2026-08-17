# =============================================================================
# Mimi Chicken OS - Branch Node Agent (Tier 2, optional)
# Runs on-prem at an outlet; holds one OUTBOUND socket.io connection to the
# cloud VPS — never an inbound port. Standalone-runnable in SIMULATE=true mode
# (no real hardware, no real LAN) so CI and every other agent can run it on a
# laptop. Signed and shipped as the image fleet-updated by W5-07.
# =============================================================================

# --- Base stage ---
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# --- Dependencies stage ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/branch-node/package.json ./apps/branch-node/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sync-protocol/package.json ./packages/sync-protocol/
RUN pnpm install --frozen-lockfile

# --- Development stage (hot reload, tsx watch) ---
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/branch-node/node_modules ./apps/branch-node/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sync-protocol/node_modules ./packages/sync-protocol/node_modules
COPY . .
WORKDIR /app/apps/branch-node
ENV SIMULATE=true
EXPOSE 4010
CMD ["pnpm", "dev"]

# --- Build stage ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/branch-node/node_modules ./apps/branch-node/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sync-protocol/node_modules ./packages/sync-protocol/node_modules
COPY . .
RUN pnpm --filter @mimi/shared build && \
    pnpm --filter @mimi/sync-protocol build && \
    pnpm --filter @mimi/branch-node build

# --- Production stage ---
# Standalone-runnable: only this app's runtime deps + the two workspace
# packages copied in as real directories (no symlinks to resolve on a
# customer's mini-PC).
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
# Hardware-free default. The physical fleet image overrides this to false
# and supplies BRANCH_NODE_CLOUD_URL + BRANCH_NODE_PAIRING_TOKEN instead.
ENV SIMULATE=true

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/branch-node/node_modules ./apps/branch-node/node_modules
COPY --from=build /app/apps/branch-node/dist ./apps/branch-node/dist
COPY --from=build /app/apps/branch-node/migrations ./apps/branch-node/migrations
COPY --from=build /app/apps/branch-node/package.json ./apps/branch-node/
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/sync-protocol ./packages/sync-protocol
COPY --from=build /app/package.json ./

RUN rm -rf /app/apps/branch-node/node_modules/@mimi/shared /app/node_modules/@mimi/shared 2>/dev/null; \
    rm -rf /app/apps/branch-node/node_modules/@mimi/sync-protocol /app/node_modules/@mimi/sync-protocol 2>/dev/null; \
    mkdir -p /app/node_modules/@mimi /app/apps/branch-node/node_modules/@mimi && \
    cp -r /app/packages/shared /app/node_modules/@mimi/shared && \
    cp -r /app/packages/shared /app/apps/branch-node/node_modules/@mimi/shared && \
    cp -r /app/packages/sync-protocol /app/node_modules/@mimi/sync-protocol && \
    cp -r /app/packages/sync-protocol /app/apps/branch-node/node_modules/@mimi/sync-protocol

WORKDIR /app/apps/branch-node
EXPOSE 4010
CMD ["node", "dist/index.js"]
