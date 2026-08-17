# =============================================================================
# Mimi Chicken OS Frontend - Multi-stage Dockerfile
# =============================================================================

# --- Base stage ---
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# --- Dependencies stage ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sync-protocol/package.json ./packages/sync-protocol/
RUN pnpm install --frozen-lockfile

# --- Development stage ---
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sync-protocol/node_modules ./packages/sync-protocol/node_modules
COPY . .
WORKDIR /app/apps/frontend
EXPOSE 3000
CMD ["pnpm", "dev"]

# --- Build stage ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sync-protocol/node_modules ./packages/sync-protocol/node_modules
COPY . .
RUN pnpm --filter @mimi/shared build && \
    pnpm --filter @mimi/sync-protocol build && \
    pnpm --filter @mimi/frontend build

# --- Production stage ---
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/apps/frontend/.next/standalone ./
COPY --from=build /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=build /app/apps/frontend/public ./apps/frontend/public

EXPOSE 3000
CMD ["node", "apps/frontend/server.js"]
