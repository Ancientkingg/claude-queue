# Stage 1: Build
FROM node:20-alpine AS builder
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
RUN cd apps/api && pnpm exec prisma generate || true

RUN cd apps/worker && pnpm exec tsc

# Stage 2: Production - slim Node image + Chromium only
FROM node:20-slim AS production

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

# Install Chromium system dependencies via apt (need playwright installed first)
RUN npx playwright install-deps chromium

# Install only Chromium browser (not Firefox/WebKit)
RUN npx playwright install chromium

# Generate Prisma client
RUN cd apps/api && pnpm exec prisma generate || true

# Copy built artifacts from builder
COPY --from=builder /app/packages/shared-types/dist/ ./packages/shared-types/dist/
COPY --from=builder /app/apps/worker/dist/ ./apps/worker/dist/

WORKDIR /app/apps/worker

CMD ["node", "dist/index.js"]
