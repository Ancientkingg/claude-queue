# Stage 1: Build
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl python3 make g++ && npm install -g pnpm

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/extension/package.json ./apps/extension/

RUN pnpm install --frozen-lockfile

COPY packages/shared-types/ ./packages/shared-types/
COPY apps/worker/ ./apps/worker/
# Copy Prisma schema (worker uses Prisma client)
COPY apps/api/prisma/ ./apps/api/prisma/

RUN cd packages/shared-types && pnpm exec tsc

# Need Prisma schema for client generation
RUN cd apps/api && pnpm exec prisma generate

RUN cd apps/worker && pnpm exec tsc

# Stage 2: Production - slim Node image + Chromium only
FROM node:22-slim AS production

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy workspace configs and package.json files for dependency install
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/extension/package.json ./apps/extension/
COPY apps/api/prisma/ ./apps/api/prisma/

# Install production dependencies (includes playwright)
RUN pnpm install --frozen-lockfile --prod

# Install Chromium + its system dependencies using the workspace-pinned Playwright.
# `pnpm exec` (run from the worker package) guarantees we invoke the exact Playwright
# version from apps/worker/package.json, so the browser build downloaded to
# /root/.cache/ms-playwright matches what the app launches at runtime. Using `npx`
# here would resolve playwright@latest from the registry and fetch a mismatched
# browser build, causing "Executable doesn't exist at .../chromium_headless_shell-*".
RUN apt-get update && cd apps/worker && pnpm exec playwright install --with-deps chromium

# Generate Prisma client
RUN cd apps/api && pnpm exec prisma generate

# Copy built artifacts from builder
COPY --from=builder /app/packages/shared-types/dist/ ./packages/shared-types/dist/
COPY --from=builder /app/apps/worker/dist/ ./apps/worker/dist/

WORKDIR /app/apps/worker

CMD ["node", "dist/index.js"]
