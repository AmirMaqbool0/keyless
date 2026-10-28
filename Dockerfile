# Multi-stage build for Keyless Sales Order Processor
FROM node:20-alpine AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

# Copy root workspace and config files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./

# Copy package manifests
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/eval/package.json ./packages/eval/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy full source trees
COPY packages/ ./packages/
COPY apps/ ./apps/

# Build all packages and apps (shared, core, eval, api, worker, web)
RUN pnpm build

# Runner stage
FROM node:20-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

ENV NODE_ENV=production
ENV PORT=4000
ENV QUEUE_DRIVER=mongo
ENV STORAGE_DRIVER=local

# Copy manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/

# Install production dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy built bundles from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Expose web/api port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start both API and Worker concurrently in one container
CMD ["pnpm", "start:prod"]
