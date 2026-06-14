# Stage 1: Build
FROM node:20-alpine AS builder
RUN npm install -g pnpm

WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
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
RUN npx -y prisma generate --schema=apps/api/prisma/schema.prisma

# Build API
RUN cd apps/api && pnpm exec tsc

# Stage 2: Production
FROM node:20-alpine AS production
RUN npm install -g pnpm

WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/extension/package.json ./apps/extension/
COPY apps/api/prisma/ ./apps/api/prisma/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Generate Prisma client in production
RUN npx -y prisma generate --schema=apps/api/prisma/schema.prisma

# Copy built files
COPY --from=builder /app/packages/shared-types/dist/ ./packages/shared-types/dist/
COPY --from=builder /app/apps/api/dist/ ./apps/api/dist/

EXPOSE 3000

# Run from the api directory
WORKDIR /app/apps/api

CMD ["node", "dist/main.js"]
