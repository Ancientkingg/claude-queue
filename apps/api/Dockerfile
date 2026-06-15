# Stage 1: Build
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl python3 make g++ && npm install -g pnpm

WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/extension/package.json ./apps/extension/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/api/ ./apps/api/

# Build shared-types first
RUN cd packages/shared-types && pnpm exec tsc

# Generate Prisma client
RUN cd apps/api && pnpm exec prisma generate

# Build API
RUN cd apps/api && pnpm exec tsc

# Stage 2: Production
FROM node:20-alpine AS production
RUN apk add --no-cache openssl && npm install -g pnpm

WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/extension/package.json ./apps/extension/
COPY apps/api/prisma/ ./apps/api/prisma/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Generate Prisma client in production
RUN cd apps/api && pnpm exec prisma generate

# Copy built files
COPY --from=builder /app/packages/shared-types/dist/ ./packages/shared-types/dist/
COPY --from=builder /app/apps/api/dist/ ./apps/api/dist/

EXPOSE 3000

# Run from the api directory
WORKDIR /app/apps/api

CMD ["sh", "-c", "pnpm exec prisma db push --skip-generate && node dist/main.js"]
