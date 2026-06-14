# Stage 1: Build
FROM node:20-alpine AS builder
RUN npm install -g pnpm

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile

COPY packages/shared-types/ ./packages/shared-types/
COPY apps/worker/ ./apps/worker/
# Copy Prisma schema (worker uses Prisma client)
COPY apps/api/prisma/ ./apps/api/prisma/

RUN cd packages/shared-types && pnpm exec tsc

# Need Prisma schema for client generation
RUN cd apps/api && mkdir -p ../api && pnpm exec prisma generate || true

RUN cd apps/worker && pnpm exec tsc

# Stage 2: Production - MUST use Playwright base image
FROM mcr.microsoft.com/playwright:v1.48.0-noble AS production

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/worker/package.json ./apps/worker/
COPY apps/api/prisma/ ./apps/api/prisma/

RUN pnpm install --frozen-lockfile --prod

# Generate Prisma client
RUN cd apps/api && pnpm exec prisma generate || true

COPY --from=builder /app/packages/shared-types/dist/ ./packages/shared-types/dist/
COPY --from=builder /app/apps/worker/dist/ ./apps/worker/dist/

WORKDIR /app/apps/worker

CMD ["node", "dist/index.js"]
